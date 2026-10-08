let mediaClock = null;

// The map, timeline and time display already read currentOffset on each frame.
// Read the media directly so those frames don't need Redux updates.
export function registerMediaClock(fullname, readOffset) {
  const clock = { fullname, readOffset };
  mediaClock = clock;
  return () => {
    if (mediaClock === clock) mediaClock = null;
  };
}

export function hasMediaClock(state) {
  return mediaClock !== null && mediaClock.fullname === state.currentRoute?.fullname;
}

export function readMediaOffset() {
  return mediaClock.readOffset();
}
