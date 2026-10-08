import { registerMediaClock } from './mediaClock';
import { currentOffset } from '.';
import { bufferVideo, pause, play, reducer, resetPlayback, seek } from './playback';

const state = () => ({
  currentRoute: { fullname: 'device|route', duration: 10000 },
  offset: 2000, startTime: Date.now(), desiredPlaySpeed: 1,
  isBufferingVideo: false, seekVersion: 0,
});

let release;
afterEach(() => release?.());

test('reads the media without extrapolating or wrapping a selection', () => {
  release = registerMediaClock('device|route', () => 6000);
  const playback = { ...state(), startTime: Date.now() - 10000, loop: { startTime: 0, duration: 5000 } };
  expect(currentOffset(playback)).toBe(6000);
  expect(reducer(playback, pause()).offset).toBe(6000);
});

test('an old clock cannot drive another route or release the new clock', () => {
  const releaseOld = registerMediaClock('other|route', () => 9000);
  expect(currentOffset({ ...state(), desiredPlaySpeed: 0 })).toBe(2000);
  release = registerMediaClock('device|route', () => 3000);
  releaseOld();
  expect(currentOffset(state())).toBe(3000);
});

test('only seek and reset change the seek counter', () => {
  release = registerMediaClock('device|route', () => 3000);
  let playback = state();
  for (const action of [bufferVideo(true), pause(), play(2), bufferVideo(false)]) {
    playback = reducer(playback, action);
    expect(playback.seekVersion).toBe(0);
  }
  playback = reducer(playback, seek(3000));
  expect(playback.seekVersion).toBe(1);
  playback = reducer(playback, seek(3000));
  expect(playback.seekVersion).toBe(2);
  expect(reducer(playback, resetPlayback()).seekVersion).toBe(3);
});

test('seeks stay within the route and ignore invalid offsets', () => {
  expect(reducer(state(), seek(-1000)).offset).toBe(0);
  expect(reducer(state(), seek(20000)).offset).toBe(10000);
  expect(reducer(state(), seek(NaN)).seekVersion).toBe(0);
});

test('the map clock loops a selection that starts at zero', () => {
  const playback = { ...state(), offset: 11000, desiredPlaySpeed: 0, loop: { startTime: 0, duration: 5000 } };
  expect(currentOffset(playback)).toBe(1000);
});
