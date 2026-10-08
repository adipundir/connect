// basic helper functions for controlling playback
// we shouldn't want to edit the raw state most of the time, helper functions are better
import * as Types from '../actions/types';
import { currentOffset } from '.';
import { hasMediaClock } from './mediaClock';

export function reducer(_state, action) {
  let state = { ..._state };
  let loopOffset = null;
  if (state.loop && state.loop.startTime !== null) {
    loopOffset = state.loop.startTime;
  }
  switch (action.type) {
    case Types.ACTION_SEEK:
      if (!Number.isFinite(action.offset)) break;
      state = {
        ...state,
        offset: Math.max(0, Math.min(action.offset, state.currentRoute?.duration ?? Infinity)),
        startTime: Date.now(),
        seekVersion: (state.seekVersion || 0) + 1,
      };

      if (loopOffset !== null) {
        if (state.offset < loopOffset) {
          state.offset = loopOffset;
        } else if (state.offset > (loopOffset + state.loop.duration)) {
          state.offset = loopOffset + state.loop.duration;
        }
      }
      break;
    case Types.ACTION_PAUSE:
      state = {
        ...state,
        offset: currentOffset(state),
        startTime: Date.now(),
        desiredPlaySpeed: 0,
      };
      break;
    case Types.ACTION_PLAY:
      if (action.speed !== state.desiredPlaySpeed) {
        state = {
          ...state,
          offset: currentOffset(state),
          desiredPlaySpeed: action.speed,
          startTime: Date.now(),
        };
      }
      break;
    case Types.ACTION_LOOP:
      if (action.start !== null && action.start !== undefined && action.end !== null && action.end !== undefined) {
        state.loop = {
          startTime: action.start,
          duration: action.end - action.start,
        };
      } else {
        state.loop = null;
      }
      state.offset = currentOffset(_state);
      if (state.loop) {
        state.offset = Math.max(action.start, Math.min(state.offset, action.end));
      }
      state.startTime = Date.now();
      state.seekVersion = (state.seekVersion || 0) + 1;
      break;
    case Types.ACTION_BUFFER_VIDEO:
      state = {
        ...state,
        isBufferingVideo: action.buffering,
        offset: currentOffset(state),
        startTime: Date.now(),
      };
      break;
    case Types.ACTION_RESET:
      state = {
        ...state,
        desiredPlaySpeed: 1,
        isBufferingVideo: true,
        offset: 0,
        startTime: Date.now(),
        seekVersion: (state.seekVersion || 0) + 1,
      };
      break;
    default:
      break;
  }

  // normalize over loop
  if (!hasMediaClock(state) && state.offset !== null && state.loop?.startTime != null && state.loop.duration > 0) {
    const playSpeed = state.isBufferingVideo ? 0 : state.desiredPlaySpeed;
    const offset = state.offset + (Date.now() - state.startTime) * playSpeed;
    loopOffset = state.loop.startTime;
    // has loop, trap offset within the loop
    if (offset < loopOffset) {
      state.startTime = Date.now();
      state.offset = loopOffset;
    } else if (offset > loopOffset + state.loop.duration) {
      state.offset = ((offset - loopOffset) % state.loop.duration) + loopOffset;
      state.startTime = Date.now();
    }
  }

  state.isBufferingVideo = Boolean(state.isBufferingVideo);

  return state;
}

// seek to a specific offset
export function seek(offset) {
  return {
    type: Types.ACTION_SEEK,
    offset,
  };
}

// pause the playback
export function pause() {
  return {
    type: Types.ACTION_PAUSE,
  };
}

// resume / change play speed
export function play(speed = 1) {
  return {
    type: Types.ACTION_PLAY,
    speed,
  };
}

export function selectLoop(start, end) {
  return {
    type: Types.ACTION_LOOP,
    start,
    end,
  };
}

// update video buffering state
export function bufferVideo(buffering) {
  return {
    type: Types.ACTION_BUFFER_VIDEO,
    buffering,
  };
}

export function resetPlayback() {
  return {
    type: Types.ACTION_RESET,
  };
}
