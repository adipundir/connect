import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { createStore } from 'redux';

import DriveVideo from '.';
import rootReducer from '../../reducers';
import { currentOffset } from '../../timeline';
import { bufferVideo, pause, play, seek, selectLoop } from '../../timeline/playback';
import * as Types from '../../actions/types';

vi.mock('../../api/backend', () => ({
  api: { video: { getQcameraStreamUrl: (fullname, exp) => `https://video.example/${fullname}/${exp}.m3u8` } },
}));
vi.mock('../../utils/browser', () => ({ isIos: () => true }));

const hlsInstances = vi.hoisted(() => []);
vi.mock('hls.js', () => ({
  default: class {
    static isSupported = () => true;
    static Events = { ERROR: 'error', BUFFER_CODECS: 'codecs' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    handlers = {};
    loadSource = vi.fn();
    startLoad = vi.fn();
    attachMedia = vi.fn();
    recoverMediaError = vi.fn();
    destroy = vi.fn();
    on(event, handler) { this.handlers[event] = handler; }
    constructor() { hlsInstances.push(this); }
  },
}));

const route = { fullname: 'device|route', duration: 60000, videoStartOffset: 1000, share_exp: 'signed' };
let playMock;
let loadMock;

beforeEach(() => {
  hlsInstances.length = 0;
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
  loadMock = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function pauseMedia() {
    if (!this.paused) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
      fireEvent.pause(this);
    }
  });
  playMock = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function playMedia() {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    return Promise.resolve();
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(state = {}, props = {}) {
  const store = createStore(rootReducer, {
    currentRoute: route, desiredPlaySpeed: 1, isBufferingVideo: true,
    offset: 0, seekVersion: 0, startTime: Date.now(), loop: null,
    ...state,
  });
  const audio = vi.fn();
  const view = render(<Provider store={store}><DriveVideo isMuted onAudioStatusChange={audio} {...props} /></Provider>);
  const video = screen.getByLabelText('Drive video');
  Object.defineProperties(video, {
    duration: { configurable: true, value: 59 },
    readyState: { configurable: true, value: 4 },
    paused: { configurable: true, value: true },
    seeking: { configurable: true, value: false },
    ended: { configurable: true, value: false },
  });
  function dispatch(action) { act(() => store.dispatch(action)); }
  function ready() { fireEvent.loadedMetadata(video); }
  return { ...view, store, video, audio, dispatch, ready };
}

test('time follows the video, including while waiting; its rate stays at the chosen speed', () => {
  const { store, video, ready } = setup();
  ready();
  video.currentTime = 12;
  expect(currentOffset(store.getState())).toBe(13000);
  fireEvent.waiting(video);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60000);
  expect(currentOffset(store.getState())).toBe(13000);
  expect(video.playbackRate).toBe(1);
  expect(video.paused).toBe(false);
  video.currentTime = 12.5;
  fireEvent.playing(video);
  expect(currentOffset(store.getState())).toBe(13500);
  expect(store.getState().isBufferingVideo).toBe(false);
});

test('buffer, pause and speed changes do not seek', () => {
  const { video, dispatch, ready } = setup();
  ready();
  video.currentTime = 7;
  const position = vi.spyOn(video, 'currentTime', 'set');
  dispatch(bufferVideo(true));
  dispatch(pause());
  dispatch(play(2));
  expect(position).not.toHaveBeenCalled();
  expect(video.playbackRate).toBe(2);
});

test('paused seeks are immediate, repeatable and clear loading when seeked', () => {
  const { store, video, dispatch, ready } = setup({ desiredPlaySpeed: 0 });
  ready();
  dispatch(seek(11000));
  expect(video.currentTime).toBe(10);
  fireEvent.seeked(video);
  expect(store.getState().isBufferingVideo).toBe(false);
  expect(video.paused).toBe(true);
  video.currentTime = 20;
  dispatch(seek(11000));
  expect(video.currentTime).toBe(10);
});

test('the latest seek before metadata wins, with the camera start offset applied once', () => {
  const { store, video, dispatch, ready } = setup({ desiredPlaySpeed: 0 });
  dispatch(seek(5000));
  dispatch(seek(21000));
  expect(currentOffset(store.getState())).toBe(21000);
  ready();
  expect(video.currentTime).toBe(20);
  fireEvent.seeked(video);
  expect(currentOffset(store.getState())).toBe(21000);
});

test('canplay clears a paused loading spinner without requiring playback', () => {
  const { store, ready } = setup({ desiredPlaySpeed: 0 });
  ready();
  expect(store.getState().isBufferingVideo).toBe(false);
  expect(playMock).not.toHaveBeenCalled();
});

test('a selection beginning at zero loops to the first camera frame', () => {
  const { video, dispatch, ready } = setup();
  ready();
  dispatch(selectLoop(0, 10000));
  fireEvent.seeked(video);
  video.currentTime = 9;
  fireEvent.playing(video);
  expect(video.currentTime).toBe(0);
});

test('the route loops at the actual end of the video, even when logs are longer', async () => {
  const { video, dispatch, ready } = setup();
  await act(async () => ready());
  dispatch(selectLoop(0, 70000));
  fireEvent.seeked(video);
  video.currentTime = 59;
  Object.defineProperties(video, {
    ended: { configurable: true, value: true },
    paused: { configurable: true, value: true },
  });
  fireEvent.ended(video);
  expect(video.currentTime).toBe(0);
  expect(playMock).toHaveBeenCalledTimes(2);
});

test('a selection with no camera frames reports an error instead of looping forever', () => {
  const { video, dispatch, ready } = setup();
  ready();
  dispatch(selectLoop(61000, 70000));
  fireEvent.seeked(video);
  fireEvent.playing(video);
  expect(screen.getByRole('alert')).toHaveTextContent('There is no video in this selection');
});

test('autoplay rejection pauses the controls and removes loading', async () => {
  playMock.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
  const { store, ready } = setup();
  await act(async () => ready());
  expect(store.getState().desiredPlaySpeed).toBe(0);
  expect(store.getState().isBufferingVideo).toBe(false);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a late play rejection from the previous route cannot pause the new route', async () => {
  let rejectPlay;
  playMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
  const { store, dispatch, ready } = setup();
  ready();
  dispatch({ type: Types.ACTION_UPDATE_ROUTE, fullname: route.fullname, route: { share_exp: 'renewed' } });
  ready();
  await act(async () => rejectPlay(new DOMException('Blocked', 'NotAllowedError')));
  expect(store.getState().desiredPlaySpeed).toBe(1);
});

test('retry reloads a failed source at the requested position', () => {
  const { video, dispatch, ready } = setup();
  ready();
  dispatch(seek(16000));
  fireEvent.seeked(video);
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
  fireEvent.error(video);
  expect(screen.getByRole('alert')).toBeVisible();
  const loads = loadMock.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(loadMock.mock.calls.length).toBeGreaterThan(loads);
  ready();
  expect(video.currentTime).toBe(15);
});

test('unmount releases the media clock and saves the last position', () => {
  const { store, video, ready, unmount } = setup();
  ready();
  video.currentTime = 23;
  unmount();
  expect(store.getState().offset).toBe(24000);
  expect(store.getState().isBufferingVideo).toBe(true);
  expect(currentOffset(store.getState())).toBe(24000);
});

test('HLS retries transient failures, recovers media once, and offers retry after a fatal failure', async () => {
  HTMLMediaElement.prototype.canPlayType.mockReturnValue('');
  const { audio, ready } = setup();
  await act(async () => {});
  const hls = hlsInstances[0];
  expect(hls).toBeDefined();
  ready();
  act(() => hls.handlers.codecs('codecs', { audio: {} }));
  expect(audio).toHaveBeenLastCalledWith(true);
  act(() => hls.handlers.error('error', { fatal: false, type: 'networkError' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  act(() => hls.handlers.error('error', { fatal: true, type: 'mediaError' }));
  expect(hls.recoverMediaError).toHaveBeenCalledTimes(1);
  act(() => hls.handlers.error('error', { fatal: true, type: 'mediaError' }));
  expect(screen.getByRole('alert')).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry' })));
  expect(hls.destroy).toHaveBeenCalled();
  expect(hlsInstances).toHaveLength(2);
  act(() => hls.handlers.error('error', { fatal: true, type: 'networkError', response: { code: 404 } }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('pause followed quickly by play supersedes the interrupted play request', async () => {
  let rejectPlay;
  playMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPlay = reject; }));
  const { store, dispatch, ready } = setup();
  ready();
  dispatch(pause());
  dispatch(play());
  expect(playMock).toHaveBeenCalledTimes(2);
  await act(async () => rejectPlay(new DOMException('Blocked', 'NotAllowedError')));
  expect(store.getState().desiredPlaySpeed).toBe(1);
});

test('map-only playback and seeking still work when the video is missing', () => {
  const { store, video, dispatch, ready } = setup({}, { mapOnly: true });
  ready();
  video.currentTime = 5;
  Object.defineProperty(video, 'error', { configurable: true, value: { code: 2 } });
  fireEvent.error(video);
  expect(store.getState().isBufferingVideo).toBe(false);
  fireEvent.waiting(video);
  expect(store.getState().isBufferingVideo).toBe(false);
  const loads = loadMock.mock.calls.length;
  dispatch(seek(20000));
  expect(currentOffset({ ...store.getState(), desiredPlaySpeed: 0 })).toBe(20000);
  expect(loadMock.mock.calls).toHaveLength(loads);
});

test('an old seeked event cannot complete a newer seek', () => {
  const { store, video, dispatch, ready } = setup({ desiredPlaySpeed: 0 });
  ready();
  dispatch(seek(10000));
  dispatch(seek(20000));
  video.currentTime = 9;
  fireEvent.seeked(video);
  expect(currentOffset(store.getState())).toBe(20000);
  expect(store.getState().isBufferingVideo).toBe(true);
  video.currentTime = 19;
  fireEvent.seeked(video);
  expect(store.getState().isBufferingVideo).toBe(false);
});

test('a selection before the first camera frame shows an empty-selection error', () => {
  const { video, dispatch, ready } = setup();
  ready();
  dispatch(selectLoop(0, 500));
  fireEvent.playing(video);
  expect(screen.getByRole('alert')).toHaveTextContent('There is no video in this selection');
});
