'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Clock3, MapPinned, Plus, Trash2 } from 'lucide-react';
import type { VideoTimelinePlan, VideoTimelineSamplingMode, VideoTimelineSegment } from '@/lib/api';

type VideoTimelinePlannerProps = {
  file: File | null;
  value?: VideoTimelinePlan;
  onChange: (plan?: VideoTimelinePlan) => void;
  disabled?: boolean;
};

type SegmentDraft = {
  label: string;
  start_time: number;
  end_time: number;
  sampling_mode: VideoTimelineSamplingMode;
  sample_count: number;
  target_fps: number;
};

const DEFAULT_SAMPLE_COUNT = 12;
const DEFAULT_SEGMENT_FPS = 2;

function formatSeconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0:00.0';
  }

  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function clampTime(value: number, duration: number) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return 0;
  }
  return Math.min(Math.max(value, 0), duration);
}

function makeSegmentId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `segment-${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
}

function getSegmentDuration(startTime: number, endTime: number) {
  return Math.max(0, endTime - startTime);
}

function getResolvedSampleCount(segment: Pick<VideoTimelineSegment, 'start_time' | 'end_time' | 'sampling_mode' | 'sample_count' | 'target_fps'>) {
  if (segment.sampling_mode === 'fps') {
    const targetFps = Math.max(0.1, Number(segment.target_fps) || DEFAULT_SEGMENT_FPS);
    return Math.max(1, Math.floor(getSegmentDuration(segment.start_time, segment.end_time) * targetFps) + 1);
  }
  return Math.max(1, Math.round(Number(segment.sample_count) || 1));
}

function makeDraft(duration: number, currentTime: number, segmentCount: number): SegmentDraft {
  const clampedCurrent = clampTime(currentTime, duration);
  const defaultStart = clampTime(Math.max(0, clampedCurrent - 2), duration);
  const defaultEnd = clampTime(Math.min(duration || clampedCurrent + 4, clampedCurrent + 4), duration || clampedCurrent + 4);

  return {
    label: `Position ${segmentCount + 1}`,
    start_time: defaultStart,
    end_time: Math.max(defaultStart + 0.5, defaultEnd),
    sampling_mode: 'count',
    sample_count: DEFAULT_SAMPLE_COUNT,
    target_fps: DEFAULT_SEGMENT_FPS,
  };
}

function normalizeSegments(segments: VideoTimelineSegment[]) {
  return segments.map((segment, index) => {
    const samplingMode = segment.sampling_mode === 'fps' ? 'fps' : 'count';
    const normalized: VideoTimelineSegment = {
      ...segment,
      position_index: index + 1,
      label: segment.label || `Position ${index + 1}`,
      sampling_mode: samplingMode,
      sample_count: getResolvedSampleCount(segment),
    };

    if (samplingMode === 'fps') {
      normalized.target_fps = Math.max(0.1, Number(segment.target_fps) || DEFAULT_SEGMENT_FPS);
    } else {
      delete normalized.target_fps;
    }

    return normalized;
  });
}

function buildPlan(fileName: string, duration: number, segments: VideoTimelineSegment[]): VideoTimelinePlan {
  const normalizedSegments = normalizeSegments(segments);
  return {
    version: 1,
    source_file_name: fileName,
    duration,
    total_sample_count: normalizedSegments.reduce((sum, segment) => sum + getResolvedSampleCount(segment), 0),
    segments: normalizedSegments,
  };
}

function getPlanKey(plan?: VideoTimelinePlan) {
  if (!plan) {
    return 'none';
  }
  return JSON.stringify(plan);
}

export default function VideoTimelinePlanner({ file, value, onChange, disabled = false }: VideoTimelinePlannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastEmittedPlanKeyRef = useRef('none');
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(value?.duration ?? 0);
  const [currentTime, setCurrentTime] = useState(0);
  const [segments, setSegments] = useState<VideoTimelineSegment[]>(value?.segments ?? []);
  const [draft, setDraft] = useState<SegmentDraft>(makeDraft(value?.duration ?? 0, 0, value?.segments?.length ?? 0));

  useEffect(() => {
    if (!file) {
      setVideoUrl(null);
      setDuration(0);
      setCurrentTime(0);
      setSegments([]);
      setDraft(makeDraft(0, 0, 0));
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setVideoUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => {
    if (!file) {
      return;
    }

    if (value?.source_file_name === file.name) {
      const externalPlanKey = getPlanKey(value);
      const localPlanKey = getPlanKey(segments.length > 0 ? buildPlan(file.name, duration, segments) : undefined);
      if (externalPlanKey !== localPlanKey) {
        setSegments(value.segments ?? []);
        if (typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration > 0) {
          setDuration(value.duration);
        }
        setDraft((current) => {
          if (
            current.label.trim()
            || current.sample_count !== DEFAULT_SAMPLE_COUNT
            || current.target_fps !== DEFAULT_SEGMENT_FPS
            || current.start_time > 0
            || current.end_time > 0
          ) {
            return current;
          }
          return makeDraft(value.duration ?? 0, currentTime, value.segments?.length ?? 0);
        });
      }
      return;
    }

    if (segments.length > 0) {
      setSegments([]);
    }
    setDraft(makeDraft(duration, 0, 0));
  }, [file, value]);

  useEffect(() => {
    if (!file || segments.length === 0) {
      if (lastEmittedPlanKeyRef.current !== 'none') {
        lastEmittedPlanKeyRef.current = 'none';
        onChange(undefined);
      }
      return;
    }

    const nextPlan = buildPlan(file.name, duration, segments);
    const nextPlanKey = getPlanKey(nextPlan);
    if (nextPlanKey === lastEmittedPlanKeyRef.current) {
      return;
    }

    lastEmittedPlanKeyRef.current = nextPlanKey;
    onChange(nextPlan);
  }, [duration, file, onChange, segments]);

  const totalSampleCount = segments.reduce((sum, segment) => sum + getResolvedSampleCount(segment), 0);
  const draftSampleCount = getResolvedSampleCount(draft);
  const canAddSegment = !disabled && file && duration > 0 && draft.end_time > draft.start_time && draftSampleCount > 0;

  const updateDraftTime = (field: 'start_time' | 'end_time', nextValue: number) => {
    const clampedValue = clampTime(nextValue, duration);
    setDraft((current) => {
      const nextDraft = { ...current, [field]: clampedValue };
      if (field === 'start_time' && nextDraft.end_time <= clampedValue) {
        nextDraft.end_time = clampTime(clampedValue + 0.5, duration || clampedValue + 0.5);
      }
      if (field === 'end_time' && nextDraft.start_time >= clampedValue) {
        nextDraft.start_time = clampTime(Math.max(0, clampedValue - 0.5), duration || clampedValue);
      }
      return nextDraft;
    });
  };

  const addSegment = () => {
    if (!canAddSegment) {
      return;
    }

    setSegments((current) => [
      ...current,
      {
        id: makeSegmentId(),
        label: draft.label.trim() || `Position ${current.length + 1}`,
        start_time: Number(draft.start_time.toFixed(3)),
        end_time: Number(draft.end_time.toFixed(3)),
        sampling_mode: draft.sampling_mode,
        sample_count: draftSampleCount,
        target_fps: draft.sampling_mode === 'fps' ? Number(draft.target_fps.toFixed(3)) : undefined,
        position_index: current.length + 1,
      },
    ]);
    setDraft(makeDraft(duration, currentTime, segments.length + 1));
  };

  const moveSegment = (index: number, direction: -1 | 1) => {
    setSegments((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const nextSegments = [...current];
      const [segment] = nextSegments.splice(index, 1);
      nextSegments.splice(nextIndex, 0, segment);
      return nextSegments;
    });
  };

  const removeSegment = (segmentId: string) => {
    setSegments((current) => current.filter((segment) => segment.id !== segmentId));
  };

  const updateSegment = (
    segmentId: string,
    field: 'label' | 'start_time' | 'end_time' | 'sample_count' | 'sampling_mode' | 'target_fps',
    rawValue: string | number,
  ) => {
    setSegments((current) => current.map((segment) => {
      if (segment.id !== segmentId) {
        return segment;
      }

      if (field === 'label') {
        return { ...segment, label: String(rawValue) };
      }

      if (field === 'sample_count') {
        return {
          ...segment,
          sample_count: Math.max(1, Number.parseInt(String(rawValue), 10) || 1),
        };
      }

      if (field === 'sampling_mode') {
        const nextMode = rawValue === 'fps' ? 'fps' : 'count';
        return {
          ...segment,
          sampling_mode: nextMode,
          target_fps: nextMode === 'fps'
            ? Math.max(0.1, Number(segment.target_fps) || DEFAULT_SEGMENT_FPS)
            : undefined,
        };
      }

      if (field === 'target_fps') {
        return {
          ...segment,
          target_fps: Math.max(0.1, Number.parseFloat(String(rawValue)) || DEFAULT_SEGMENT_FPS),
        };
      }

      const nextValue = clampTime(Number(rawValue), duration);
      if (field === 'start_time') {
        return {
          ...segment,
          start_time: nextValue,
          end_time: Math.max(nextValue + 0.1, segment.end_time),
        };
      }

      return {
        ...segment,
        start_time: Math.min(segment.start_time, Math.max(0, nextValue - 0.1)),
        end_time: nextValue,
      };
    }));
  };

  const jumpToTime = (time: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }
    video.currentTime = clampTime(time, duration);
    setCurrentTime(video.currentTime);
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(320px,0.9fr)]">
        <div className="border border-[color:var(--ink)] bg-white p-3 shadow-[var(--shadow-sm)]">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="brutal-label">Preview</p>
              <p className="text-sm text-[color:var(--text-secondary)]">ใช้ video preview เพื่อ mark ช่วงเวลาของแต่ละตำแหน่งก่อน export เฟรม</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-bold uppercase tracking-[0.12em] text-[color:var(--text-secondary)]">
              <span className="border border-[color:var(--ink)] bg-[var(--paper-muted)] px-2 py-1">{file?.name ?? 'No video'}</span>
              <span className="border border-[color:var(--ink)] bg-[var(--paper-muted)] px-2 py-1">duration {formatSeconds(duration)}</span>
            </div>
          </div>

          <div className="overflow-hidden border border-[color:var(--ink)] bg-[var(--paper-muted)]">
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                preload="metadata"
                className="aspect-video w-full bg-black"
                onLoadedMetadata={(event) => {
                  const nextDuration = Number(event.currentTarget.duration) || 0;
                  setDuration(nextDuration);
                  setDraft((current) => {
                    if (current.end_time > 0) {
                      return current;
                    }
                    return makeDraft(nextDuration, event.currentTarget.currentTime, segments.length);
                  });
                }}
                onTimeUpdate={(event) => {
                  setCurrentTime(Number(event.currentTarget.currentTime) || 0);
                }}
              />
            ) : (
              <div className="flex aspect-video items-center justify-center px-6 text-center text-sm text-[color:var(--text-secondary)]">
                เลือกวิดีโอหนึ่งไฟล์เพื่อเปิด timeline planner
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-2 md:grid-cols-3">
            <div className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-3 py-2">
              <p className="brutal-label">Current</p>
              <p className="mt-1 text-lg font-black text-[var(--ink)]">{formatSeconds(currentTime)}</p>
            </div>
            <button
              type="button"
              onClick={() => updateDraftTime('start_time', currentTime)}
              disabled={disabled || !file}
              className="brutal-btn justify-center disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Clock3 className="mr-2 h-4 w-4" />
              Mark Start
            </button>
            <button
              type="button"
              onClick={() => updateDraftTime('end_time', currentTime)}
              disabled={disabled || !file}
              className="brutal-btn justify-center disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Clock3 className="mr-2 h-4 w-4" />
              Mark End
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="border border-[color:var(--ink)] bg-[var(--paper-card)] p-3 shadow-[var(--shadow-sm)]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="brutal-label">Segment Draft</p>
                <p className="text-sm text-[color:var(--text-secondary)]">กำหนดช่วงเวลาแล้วเลือกได้ว่าจะใส่เป็นจำนวนรูปหรือ FPS ต่อช่วง</p>
              </div>
              <span className="border border-[color:var(--ink)] bg-[var(--paper-muted)] px-2 py-1 text-xs font-bold uppercase tracking-[0.12em]">flat export: posNNN_XXXX.jpg</span>
            </div>

            <div className="mt-3 space-y-3">
              <div>
                <label className="brutal-label mb-1.5 inline-block">Position Label</label>
                <input
                  type="text"
                  value={draft.label}
                  onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                  className="brutal-input"
                  placeholder="Position 1"
                  disabled={disabled || !file}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="brutal-label mb-1.5 inline-block">Start</label>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={Math.min(draft.start_time, duration || 0)}
                    onChange={(event) => updateDraftTime('start_time', Number(event.target.value))}
                    className="w-full"
                    disabled={disabled || !file || duration <= 0}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm text-[color:var(--text-secondary)]">
                    <span>{formatSeconds(draft.start_time)}</span>
                    <button type="button" onClick={() => jumpToTime(draft.start_time)} className="font-bold text-[var(--ink)]" disabled={!file}>seek</button>
                  </div>
                </div>
                <div>
                  <label className="brutal-label mb-1.5 inline-block">End</label>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={Math.min(draft.end_time, duration || 0)}
                    onChange={(event) => updateDraftTime('end_time', Number(event.target.value))}
                    className="w-full"
                    disabled={disabled || !file || duration <= 0}
                  />
                  <div className="mt-1 flex items-center justify-between gap-2 text-sm text-[color:var(--text-secondary)]">
                    <span>{formatSeconds(draft.end_time)}</span>
                    <button type="button" onClick={() => jumpToTime(draft.end_time)} className="font-bold text-[var(--ink)]" disabled={!file}>seek</button>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label className="brutal-label mb-1.5 inline-block">Sampling Mode</label>
                  <select
                    value={draft.sampling_mode}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      sampling_mode: event.target.value === 'fps' ? 'fps' : 'count',
                      target_fps: event.target.value === 'fps'
                        ? Math.max(0.1, current.target_fps || DEFAULT_SEGMENT_FPS)
                        : current.target_fps,
                    }))}
                    className="brutal-select"
                    disabled={disabled || !file}
                  >
                    <option value="count">Fixed image count</option>
                    <option value="fps">FPS within this segment</option>
                  </select>
                </div>
                <div>
                  <label className="brutal-label mb-1.5 inline-block">{draft.sampling_mode === 'fps' ? 'Target FPS' : 'Sample Count'}</label>
                  {draft.sampling_mode === 'fps' ? (
                    <input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={draft.target_fps}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        target_fps: Math.max(0.1, Number.parseFloat(event.target.value) || DEFAULT_SEGMENT_FPS),
                      }))}
                      className="brutal-input"
                      disabled={disabled || !file}
                    />
                  ) : (
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={draft.sample_count}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        sample_count: Math.max(1, Number.parseInt(event.target.value, 10) || 1),
                      }))}
                      className="brutal-input"
                      disabled={disabled || !file}
                    />
                  )}
                </div>
                <div className="border border-[color:var(--ink)] bg-[var(--paper-muted)] px-3 py-2 text-sm text-[color:var(--text-secondary)] md:col-span-2">
                  <p className="brutal-label mb-1">Segment Preview</p>
                  <p>{formatSeconds(draft.start_time)} - {formatSeconds(draft.end_time)}</p>
                  <p className="mt-1 font-bold text-[var(--ink)]">
                    {draft.sampling_mode === 'fps'
                      ? `${draft.target_fps.toFixed(1)} fps -> ${draftSampleCount} images`
                      : `${draftSampleCount} images`}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={addSegment}
                disabled={!canAddSegment}
                className="brutal-btn brutal-btn-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Position Segment
              </button>
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
            <div className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-3 py-2 shadow-[var(--shadow-sm)]">
              <p className="brutal-label">Positions</p>
              <p className="mt-1 text-lg font-black text-[var(--ink)]">{segments.length}</p>
            </div>
            <div className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-3 py-2 shadow-[var(--shadow-sm)]">
              <p className="brutal-label">Exported Images</p>
              <p className="mt-1 text-lg font-black text-[var(--ink)]">{totalSampleCount}</p>
            </div>
            <div className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-3 py-2 shadow-[var(--shadow-sm)]">
              <p className="brutal-label">Pattern</p>
              <p className="mt-1 text-sm font-black uppercase tracking-[0.08em] text-[var(--ink)]">pos001_0001.jpg</p>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {segments.length === 0 ? (
          <div className="border border-dashed border-[color:var(--ink)] bg-[var(--paper-muted)] px-4 py-5 text-sm text-[color:var(--text-secondary)]">
            ยังไม่มีตำแหน่งที่กำหนดไว้ เพิ่มอย่างน้อย 1 segment ก่อนเริ่มอัปโหลดในโหมด simulated 360
          </div>
        ) : (
          segments.map((segment, index) => {
            const segmentCode = `pos${String(index + 1).padStart(3, '0')}`;
            const resolvedSampleCount = getResolvedSampleCount(segment);
            return (
              <div key={segment.id} className="border border-[color:var(--ink)] bg-white p-3 shadow-[var(--shadow-sm)]">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="border border-[color:var(--ink)] bg-[var(--paper-muted)] px-2 py-1 text-xs font-bold uppercase tracking-[0.12em]">{segmentCode}</span>
                      <h4 className="text-base font-black text-[var(--ink)]">{segment.label || `Position ${index + 1}`}</h4>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-xs font-medium text-[color:var(--text-secondary)]">
                      <span className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-2 py-1">{formatSeconds(segment.start_time)} - {formatSeconds(segment.end_time)}</span>
                      <span className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-2 py-1">
                        {segment.sampling_mode === 'fps'
                          ? `${(segment.target_fps ?? DEFAULT_SEGMENT_FPS).toFixed(1)} fps -> ${resolvedSampleCount} images`
                          : `${resolvedSampleCount} images`}
                      </span>
                      <span className="border border-[color:var(--ink)] bg-[var(--paper-card)] px-2 py-1">preview: {segmentCode}_0001.jpg</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => jumpToTime(segment.start_time)} className="brutal-btn">
                      <MapPinned className="mr-2 h-4 w-4" />
                      Seek
                    </button>
                    <button type="button" onClick={() => moveSegment(index, -1)} className="brutal-btn" disabled={index === 0}>
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => moveSegment(index, 1)} className="brutal-btn" disabled={index === segments.length - 1}>
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => removeSegment(segment.id)} className="brutal-btn">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                  <div>
                    <label className="brutal-label mb-1.5 inline-block">Label</label>
                    <input
                      type="text"
                      value={segment.label}
                      onChange={(event) => updateSegment(segment.id, 'label', event.target.value)}
                      className="brutal-input"
                      disabled={disabled}
                    />
                  </div>
                  <div>
                    <label className="brutal-label mb-1.5 inline-block">Start</label>
                    <input
                      type="number"
                      min={0}
                      max={duration || undefined}
                      step={0.1}
                      value={segment.start_time}
                      onChange={(event) => updateSegment(segment.id, 'start_time', event.target.value)}
                      className="brutal-input"
                      disabled={disabled}
                    />
                  </div>
                  <div>
                    <label className="brutal-label mb-1.5 inline-block">End</label>
                    <input
                      type="number"
                      min={0}
                      max={duration || undefined}
                      step={0.1}
                      value={segment.end_time}
                      onChange={(event) => updateSegment(segment.id, 'end_time', event.target.value)}
                      className="brutal-input"
                      disabled={disabled}
                    />
                  </div>
                  <div>
                    <label className="brutal-label mb-1.5 inline-block">Sampling Mode</label>
                    <select
                      value={segment.sampling_mode === 'fps' ? 'fps' : 'count'}
                      onChange={(event) => updateSegment(segment.id, 'sampling_mode', event.target.value)}
                      className="brutal-select"
                      disabled={disabled}
                    >
                      <option value="count">Fixed image count</option>
                      <option value="fps">FPS within segment</option>
                    </select>
                  </div>
                  <div>
                    <label className="brutal-label mb-1.5 inline-block">{segment.sampling_mode === 'fps' ? 'Target FPS' : 'Frames In This Segment'}</label>
                    {segment.sampling_mode === 'fps' ? (
                      <input
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={segment.target_fps ?? DEFAULT_SEGMENT_FPS}
                        onChange={(event) => updateSegment(segment.id, 'target_fps', event.target.value)}
                        className="brutal-input"
                        disabled={disabled}
                      />
                    ) : (
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={segment.sample_count}
                        onChange={(event) => updateSegment(segment.id, 'sample_count', event.target.value)}
                        className="brutal-input"
                        disabled={disabled}
                      />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}