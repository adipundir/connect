import React, { Component } from 'react';
import { connect } from 'react-redux';
import { Button, CircularProgress, Typography } from '@material-ui/core';

import { api } from '../../api/backend';
import Colors from '../../colors';
import { ErrorOutline } from '../../icons';
import { currentOffset } from '../../timeline';
import { registerMediaClock } from '../../timeline/mediaClock';
import { pause, bufferVideo } from '../../timeline/playback';
import { isIos } from '../../utils/browser';

const VideoOverlay = ({ loading, error, onRetry }) => {
  if (!loading && !error) return null;
  return (
    <div className="z-50 absolute inset-0 flex items-center justify-center bg-[#16181AAA]">
      <div className="text-center">
        {error ? (
          <>
            <ErrorOutline className="mb-2" />
            <Typography role="alert">{error}</Typography>
            <Button onClick={onRetry} style={{ color: Colors.white }}>Retry</Button>
          </>
        ) : <CircularProgress aria-label="Loading video" style={{ color: Colors.white }} thickness={4} size={50} />}
      </div>
    </div>
  );
};

export class DriveVideo extends Component {
  video = React.createRef();
  state = { error: null };
  loadVersion = 0;
  pendingOffset = null;

  componentDidMount() {
    this.mounted = true;
    this.loadSource();
  }

  componentDidUpdate(prevProps) {
    if (prevProps.currentRoute?.fullname !== this.props.currentRoute?.fullname || this.sourceUrl(prevProps) !== this.sourceUrl(this.props)) {
      this.loadSource(prevProps.currentRoute?.fullname === this.props.currentRoute?.fullname ? this.readOffset() : undefined);
      return;
    }
    if (prevProps.seekVersion !== this.props.seekVersion) {
      if (!this.props.mapOnly || !this.state.error) this.seekTo(this.props.offset);
    }
    if (prevProps.desiredPlaySpeed !== this.props.desiredPlaySpeed) this.applyControls();
    if (prevProps.mapOnly !== this.props.mapOnly) {
      if (prevProps.mapOnly && this.state.error) this.loadSource(currentOffset(this.props));
      else this.updateClock();
    }
  }

  componentWillUnmount() {
    this.setBuffering(true);
    this.mounted = false;
    this.loadVersion += 1;
    this.disposeSource();
  }

  sourceUrl = (props) => {
    const route = props.currentRoute;
    return route ? api.video.getQcameraStreamUrl(route.fullname, route.share_exp, route.share_sig) : null;
  };

  disposeSource = () => {
    this.loadingSource = true;
    cancelAnimationFrame(this.frame);
    this.releaseClock?.();
    this.releaseClock = null;
    this.hls?.destroy();
    this.hls = null;
    const video = this.video.current;
    video.pause();
    video.removeAttribute('src');
    video.load();
  };

  loadSource = async (offset = this.props.offset ?? this.props.loop?.startTime ?? 0) => {
    if (!Number.isFinite(offset)) offset = 0;
    this.loadVersion += 1;
    const version = this.loadVersion;
    this.disposeSource();
    this.ready = false;
    this.playPending = false;
    this.pendingOffset = offset;
    this.mediaRecovered = false;
    this.setState({ error: null });
    this.props.onAudioStatusChange?.(false);
    this.updateClock(false);
    this.setBuffering(true);
    const src = this.sourceUrl(this.props);
    if (!src) return;
    const video = this.video.current;
    this.loadingSource = false;
    if (isIos() && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.load();
      video.currentTime = Math.max(0, (offset - this.videoStart()) / 1000);
      return;
    }
    try {
      const { default: Hls } = await import('hls.js');
      if (!this.mounted || version !== this.loadVersion) return;
      if (!Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src;
          video.load();
          video.currentTime = Math.max(0, (offset - this.videoStart()) / 1000);
        } else this.fail('Video playback is not supported in this browser.');
        return;
      }
      const hls = new Hls({ maxBufferLength: 40, startPosition: Math.max(0, ((this.pendingOffset ?? offset) - this.videoStart()) / 1000) });
      this.hls = hls;
      hls.on(Hls.Events.BUFFER_CODECS, (_event, data) => {
        if (version === this.loadVersion) this.props.onAudioStatusChange?.(Boolean(data.audio));
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (version !== this.loadVersion || !data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !this.mediaRecovered) {
          this.mediaRecovered = true;
          this.pendingOffset = this.readOffset();
          this.ready = false;
          this.setBuffering(true);
          hls.recoverMediaError();
          return;
        }
        this.fail(data.response?.code === 404
          ? 'This video segment has not uploaded yet or has been deleted.'
          : 'Unable to load video. Check your connection and retry.');
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } catch {
      if (this.mounted && version === this.loadVersion) this.fail('Unable to load the video player. Retry to try again.');
    }
  };

  // Map-only routes still use the existing map clock when video is unavailable.
  updateClock = (failed = Boolean(this.state.error)) => {
    this.releaseClock?.();
    this.releaseClock = null;
    if (this.props.mapOnly && failed) {
      this.setBuffering(false);
    } else if (this.props.currentRoute) {
      this.releaseClock = registerMediaClock(this.props.currentRoute.fullname, this.readOffset);
    }
  };

  readOffset = () => this.pendingOffset ?? (
    this.ready ? this.video.current.currentTime * 1000 + this.videoStart() : this.props.offset ?? 0
  );

  videoStart = () => this.props.currentRoute?.videoStartOffset || 0;

  setBuffering = (buffering) => {
    if (this.props.isBufferingVideo !== buffering) this.props.dispatch(bufferVideo(buffering));
  };

  seekTo = (offset) => {
    if (!Number.isFinite(offset)) return;
    if (this.state.error) {
      this.loadSource(offset);
      return;
    }
    const video = this.video.current;
    this.pendingOffset = Math.max(this.videoStart(), offset);
    if (!this.ready) {
      this.hls?.startLoad(Math.max(0, (offset - this.videoStart()) / 1000));
      return;
    }
    const seconds = Math.max(0, Math.min(video.duration, (offset - this.videoStart()) / 1000));
    this.pendingOffset = seconds * 1000 + this.videoStart();
    if (Math.abs(video.currentTime - seconds) < 0.001 && !video.seeking) {
      this.pendingOffset = null;
      return;
    }
    video.currentTime = seconds;
    this.setBuffering(true);
  };

  onReady = () => {
    const video = this.video.current;
    if (this.loadingSource || this.state.error || !Number.isFinite(video.duration) || video.duration <= 0) return;
    this.ready = true;
    if (this.pendingOffset !== null) this.seekTo(this.pendingOffset);
    if (video.audioTracks) this.props.onAudioStatusChange?.(video.audioTracks.length > 0);
    if (!video.seeking && video.readyState >= 2) this.setBuffering(false);
    this.applyControls();
  };

  applyControls = () => {
    const video = this.video.current;
    const speed = this.props.desiredPlaySpeed;
    if (!speed) {
      this.playPending = false;
      video.pause();
      return;
    }
    if (!this.ready || this.state.error) return;
    if (video.playbackRate !== speed) video.playbackRate = speed;
    if (!video.paused || this.playPending) return;
    const version = this.loadVersion;
    const attempt = {};
    this.playPending = attempt;
    Promise.resolve(video.play()).catch((error) => {
      if (!this.mounted || version !== this.loadVersion || this.playPending !== attempt || !this.props.desiredPlaySpeed) return;
      if (error.name === 'NotAllowedError') {
        this.props.dispatch(pause());
        this.setBuffering(false);
      } else if (error.name !== 'AbortError') {
        this.fail('Unable to play video. Retry to try again.');
      }
    }).finally(() => {
      if (version === this.loadVersion && this.playPending === attempt) this.playPending = false;
    });
  };

  onWaiting = () => {
    if (!this.loadingSource && !this.state.error) this.setBuffering(true);
  };

  onSeeked = () => {
    if (this.loadingSource || this.state.error || !this.ready) return;
    // An older seek may finish after another timeline click.
    if (this.pendingOffset !== null && Math.abs(this.video.current.currentTime * 1000 + this.videoStart() - this.pendingOffset) > 1) return;
    this.pendingOffset = null;
    if (this.video.current.readyState >= 2) this.setBuffering(false);
  };

  onPlaying = () => {
    if (this.loadingSource || this.state.error) return;
    this.setBuffering(false);
    cancelAnimationFrame(this.frame);
    this.checkLoop();
  };

  onPause = () => {
    cancelAnimationFrame(this.frame);
    if (this.ready && !this.loadingSource && !this.state.error && this.video.current.paused && !this.video.current.ended && this.props.desiredPlaySpeed) {
      this.props.dispatch(pause());
    }
  };

  checkLoop = () => {
    if (!this.mounted || this.state.error) return;
    const video = this.video.current;
    const { loop, desiredPlaySpeed } = this.props;
    if (this.ready && desiredPlaySpeed && !video.seeking && this.pendingOffset === null && loop?.duration > 0) {
      const start = Math.max(loop.startTime, this.videoStart());
      const end = Math.min(loop.startTime + loop.duration, this.videoStart() + video.duration * 1000);
      if (end <= start) {
        this.fail('There is no video in this selection. Choose another part of the drive.');
        return;
      }
      const offset = this.readOffset();
      if (offset >= end || offset < start) this.seekTo(start);
    }
    if (!video.paused) this.frame = requestAnimationFrame(this.checkLoop);
  };

  onEnded = () => {
    this.checkLoop();
    if (this.pendingOffset !== null) this.applyControls();
    else this.props.dispatch(pause());
  };

  fail = (error) => {
    this.setState({ error }, () => {
      this.updateClock(true);
      this.setBuffering(!this.props.mapOnly);
      this.video.current.pause();
    });
  };

  onError = () => {
    if (!this.loadingSource && this.video.current.error) this.fail('Unable to load video. Check your connection and retry.');
  };

  retry = () => this.loadSource(this.props.mapOnly && this.state.error ? currentOffset(this.props) : this.readOffset());

  render() {
    const { isBufferingVideo, isMuted, mapOnly } = this.props;
    return (
      <div className={`${mapOnly ? '' : 'min-h-[200px]'} relative max-w-[964px] m-[0_auto] aspect-[1.593]`}>
        <VideoOverlay loading={isBufferingVideo} error={this.state.error} onRetry={this.retry} />
        <video
          ref={this.video}
          aria-label="Drive video"
          className="w-full h-full"
          playsInline
          muted={isMuted}
          preload="auto"
          onLoadedMetadata={this.onReady}
          onDurationChange={this.onReady}
          onCanPlay={this.onReady}
          onWaiting={this.onWaiting}
          onSeeking={this.onWaiting}
          onSeeked={this.onSeeked}
          onPlaying={this.onPlaying}
          onPause={this.onPause}
          onEnded={this.onEnded}
          onError={this.onError}
        />
      </div>
    );
  }
}

const stateToProps = (state) => ({
  desiredPlaySpeed: state.desiredPlaySpeed,
  offset: state.offset,
  startTime: state.startTime,
  seekVersion: state.seekVersion,
  loop: state.loop,
  isBufferingVideo: state.isBufferingVideo,
  currentRoute: state.currentRoute,
});

export default connect(stateToProps)(DriveVideo);
