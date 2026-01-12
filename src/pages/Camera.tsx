import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import './camera.css'

type AngleResult = {
  id: string
  azimuth: number
  elevation: number
  distance: number
  status: 'queued' | 'running' | 'done' | 'error'
  image?: string
  seed?: number
  error?: string
}

const AZIMUTH_MAP: Record<number, string> = {
  0: 'front view',
  45: 'front-right quarter view',
  90: 'right side view',
  135: 'back-right quarter view',
  180: 'back view',
  225: 'back-left quarter view',
  270: 'left side view',
  315: 'front-left quarter view',
}

const ELEVATION_MAP: Record<number, string> = {
  [-30]: 'low-angle shot',
  0: 'eye-level shot',
  30: 'elevated shot',
  60: 'high-angle shot',
}

const DISTANCE_MAP: Record<number, string> = {
  0.6: 'close-up',
  1.0: 'medium shot',
  1.4: 'wide shot',
}

const ANGLE_PRESETS = Object.keys(AZIMUTH_MAP)
  .map((value) => Number(value))
  .sort((a, b) => a - b)
const ANGLE_COUNT = ANGLE_PRESETS.length
const ELEVATION_PRESETS = Object.keys(ELEVATION_MAP)
  .map((value) => Number(value))
  .sort((a, b) => a - b)
const DISTANCE_PRESETS = Object.keys(DISTANCE_MAP)
  .map((value) => Number(value))
  .sort((a, b) => a - b)
const MAX_PARALLEL = 3
const API_ENDPOINT = '/api/qwen'
const DRAG_PIXELS_PER_STEP = 16

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const runQueue = async (tasks: Array<() => Promise<void>>, concurrency: number) => {
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= tasks.length) return
      await tasks[index]()
    }
  })
  await Promise.all(runners)
}

const makeId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const snapToNearest = (value: number, options: number[]) =>
  options.reduce((nearest, option) => (Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest))

const buildAnglePrompt = (azimuth: number, elevation: number, distance: number, extraPrompt: string) => {
  const azimuthSnap = snapToNearest(azimuth, ANGLE_PRESETS)
  const elevationSnap = snapToNearest(elevation, ELEVATION_PRESETS)
  const distanceSnap = snapToNearest(distance, DISTANCE_PRESETS)
  const anglePrompt = `<sks> ${AZIMUTH_MAP[azimuthSnap]} ${ELEVATION_MAP[elevationSnap]} ${DISTANCE_MAP[distanceSnap]}`
  const suffix = extraPrompt.trim()
  return suffix ? `${anglePrompt} ${suffix}` : anglePrompt
}

const toBase64 = (dataUrl: string) => {
  const parts = dataUrl.split(',')
  return parts.length > 1 ? parts[1] : dataUrl
}

const normalizeImage = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('data:') || value.startsWith('http')) return value
  return `data:image/png;base64,${value}`
}

const extractImageList = (payload: any) => {
  const output = payload?.output ?? payload?.result ?? payload
  const listCandidates = [output?.images, output?.outputs, output?.output_images, output?.data, payload?.images]
  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue
    const normalized = candidate
      .map((item: any) => normalizeImage(item?.image ?? item?.url ?? item?.data ?? item))
      .filter(Boolean) as string[]
    if (normalized.length) return normalized
  }
  const singleCandidates = [
    output?.image,
    output?.output_image,
    output?.output_image_base64,
    output?.message,
    output?.data,
    payload?.image,
    payload?.data,
  ]
  for (const candidate of singleCandidates) {
    const normalized = normalizeImage(candidate)
    if (normalized) return [normalized]
  }
  return []
}

const extractJobId = (payload: any) => payload?.id || payload?.jobId || payload?.job_id || payload?.output?.id

const wrapIndex = (value: number, length: number) => {
  if (!length) return 0
  return ((value % length) + length) % length
}

const findNearestImageIndex = (index: number, items: AngleResult[]) => {
  if (!items.length) return -1
  if (items[index]?.image) return index
  for (let offset = 1; offset < items.length; offset += 1) {
    const right = wrapIndex(index + offset, items.length)
    const left = wrapIndex(index - offset, items.length)
    if (items[right]?.image) return right
    if (items[left]?.image) return left
  }
  return -1
}

export function Camera() {
  const [sourcePreview, setSourcePreview] = useState<string | null>(null)
  const [sourcePayload, setSourcePayload] = useState<string | null>(null)
  const [sourceName, setSourceName] = useState('')
  const [prompt, setPrompt] = useState('clean studio photo, centered subject, soft rim light')
  const [elevation, setElevation] = useState(20)
  const [distance, setDistance] = useState(1.0)
  const [guidanceScale, setGuidanceScale] = useState(3.5)
  const [steps, setSteps] = useState(16)
  const [width, setWidth] = useState(512)
  const [height, setHeight] = useState(512)
  const [seed, setSeed] = useState(1234)
  const [randomizeSeed, setRandomizeSeed] = useState(true)
  const [results, setResults] = useState<AngleResult[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [statusMessage, setStatusMessage] = useState('Upload an image to render all angles.')
  const [isRunning, setIsRunning] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const runIdRef = useRef(0)
  const dragRef = useRef<{ active: boolean; startX: number; startIndex: number }>({
    active: false,
    startX: 0,
    startIndex: 0,
  })

  const angleLabels = useMemo(
    () => ANGLE_PRESETS.map((angle) => AZIMUTH_MAP[angle] ?? `${Math.round(angle)} deg`),
    [],
  )

  const totalFrames = results.length || ANGLE_PRESETS.length
  const completedCount = useMemo(() => results.filter((item) => item.image).length, [results])
  const progress = totalFrames ? completedCount / totalFrames : 0

  const displayIndex = useMemo(() => findNearestImageIndex(selectedIndex, results), [selectedIndex, results])
  const displayImage = displayIndex >= 0 ? results[displayIndex]?.image : null
  const emptyMessage = sourcePayload ? 'Rendering frames...' : 'Upload an image to begin.'

  const viewerStyle = useMemo(
    () =>
      ({
        '--progress': progress,
      }) as CSSProperties,
    [progress],
  )

  const buildViews = useCallback(
    () => ANGLE_PRESETS.map((angle) => ({ azimuth: angle, elevation, distance })),
    [distance, elevation],
  )

  const applyImageAt = useCallback((index: number, image: string) => {
    setResults((prev) =>
      prev.map((item, itemIndex) => ({
        ...item,
        status: itemIndex === index ? 'done' : item.status,
        image: itemIndex === index ? image : item.image,
      })),
    )
    setSelectedIndex((prev) => {
      if (prev === index) return prev
      if (!results[prev]?.image) return index
      return prev
    })
  }, [results])

  const submitAngle = useCallback(
    async (anglePrompt: string, payload: string) => {
      if (!payload) throw new Error('Image is missing.')
      const input = {
        image_base64: payload,
        prompt: anglePrompt,
        guidance_scale: guidanceScale,
        num_inference_steps: steps,
        width,
        height,
        seed,
        randomize_seed: randomizeSeed,
        worker_mode: 'comfyui',
      }
      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = data?.error || data?.message || 'Request failed.'
        throw new Error(message)
      }
      const images = extractImageList(data)
      if (images.length) {
        return { images }
      }
      const jobId = extractJobId(data)
      if (!jobId) throw new Error('Missing job id.')
      return { jobId }
    },
    [guidanceScale, height, randomizeSeed, seed, steps, width],
  )

  const pollJob = useCallback(async (jobId: string, runId: number) => {
    for (let i = 0; i < 120; i += 1) {
      if (runIdRef.current !== runId) return { status: 'cancelled' as const, images: [] }
      const res = await fetch(`${API_ENDPOINT}?id=${encodeURIComponent(jobId)}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message = data?.error || data?.message || 'Status request failed.'
        throw new Error(message)
      }
      const status = String(data?.status || data?.state || '').toLowerCase()
      if (status.includes('fail')) {
        throw new Error(data?.error || 'Render failed.')
      }
      const images = extractImageList(data)
      if (images.length) {
        return { status: 'done' as const, images }
      }
      await wait(1500 + i * 40)
    }
    throw new Error('Render timed out.')
  }, [])

  const startBatch = useCallback(
    async (payload: string) => {
      if (!payload) return
      const runId = runIdRef.current + 1
      runIdRef.current = runId
      setIsRunning(true)
      setStatusMessage(`Rendering ${ANGLE_COUNT} angles...`)
      const views = buildViews()
      setResults(
        views.map((view) => ({
          id: makeId(),
          azimuth: view.azimuth,
          elevation: view.elevation,
          distance: view.distance,
          status: 'queued' as const,
        })),
      )
      setSelectedIndex(0)

      try {
        const tasks = views.map((view, index) => async () => {
          if (runIdRef.current !== runId) return
          setResults((prev) =>
            prev.map((item, itemIndex) =>
              itemIndex === index ? { ...item, status: 'running' as const, error: undefined } : item,
            ),
          )
          const anglePrompt = buildAnglePrompt(view.azimuth, view.elevation, view.distance, prompt)
          try {
            const submitted = await submitAngle(anglePrompt, payload)
            if (runIdRef.current !== runId) return
            if ('images' in submitted && submitted.images.length) {
              applyImageAt(index, submitted.images[0])
              return
            }
            if ('jobId' in submitted) {
              const polled = await pollJob(submitted.jobId, runId)
              if (runIdRef.current !== runId) return
              if (polled.status === 'done' && polled.images.length) {
                applyImageAt(index, polled.images[0])
              }
            }
          } catch (error) {
            if (runIdRef.current !== runId) return
            const message = error instanceof Error ? error.message : 'Request failed.'
            setResults((prev) =>
              prev.map((item, itemIndex) =>
                itemIndex === index ? { ...item, status: 'error' as const, error: message } : item,
              ),
            )
            setStatusMessage(message)
          }
        })

        await runQueue(tasks, MAX_PARALLEL)
        if (runIdRef.current === runId) {
          setStatusMessage('Completed.')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Request failed.'
        setStatusMessage(message)
        setResults((prev) => prev.map((item) => ({ ...item, status: 'error', error: message })))
      } finally {
        if (runIdRef.current === runId) {
          setIsRunning(false)
        }
      }
    },
    [applyImageAt, buildViews, pollJob, prompt, submitAngle],
  )

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const payload = toBase64(dataUrl)
      setSourcePreview(dataUrl)
      setSourcePayload(payload)
      setSourceName(file.name)
      void startBatch(payload)
    }
    reader.readAsDataURL(file)
  }

  const handleSelect = (index: number) => {
    if (!results[index]) return
    setSelectedIndex(index)
  }

  const handleRenderAll = async () => {
    if (!sourcePayload) return
    await startBatch(sourcePayload)
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (results.length === 0) return
    dragRef.current = {
      active: true,
      startX: event.clientX,
      startIndex: selectedIndex,
    }
    setIsDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current.active || results.length === 0) return
    const delta = event.clientX - dragRef.current.startX
    const step = Math.round(delta / DRAG_PIXELS_PER_STEP)
    const next = wrapIndex(dragRef.current.startIndex - step, ANGLE_PRESETS.length)
    if (next !== selectedIndex) {
      setSelectedIndex(next)
    }
  }

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    dragRef.current.active = false
    setIsDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (results.length === 0) return
    if (event.key === 'ArrowRight') {
      setSelectedIndex((prev) => wrapIndex(prev + 1, ANGLE_PRESETS.length))
    }
    if (event.key === 'ArrowLeft') {
      setSelectedIndex((prev) => wrapIndex(prev - 1, ANGLE_PRESETS.length))
    }
  }

  return (
    <div className="camera-app">
      <header className="camera-hero">
        <div>
          <p className="camera-hero__eyebrow">Multi-Angle Camera</p>
          <h1>Spin-ready renders from a single upload</h1>
          <p className="camera-hero__lede">
            Drop one image, render every angle, and scrub the turntable like a 3D viewer. Perfect for
            product shots, characters, and visual QA.
          </p>
        </div>
        <div className="camera-hero__badge">
          <span>Serverless</span>
          <strong>RunPod + ComfyUI</strong>
        </div>
      </header>

      <div className="camera-shell">
        <section className="camera-panel">
          <div className="panel-header">
            <h2>Input</h2>
            <span>{statusMessage}</span>
          </div>
          <label className="upload-box">
            <input type="file" accept="image/*" onChange={handleFileChange} />
            <div>
              <strong>{sourceName || 'Click to upload your source image'}</strong>
              <span>PNG or JPG. Auto-renders all {ANGLE_COUNT} angles after upload.</span>
            </div>
          </label>
          {sourcePreview && (
            <div className="preview-card">
              <img src={sourcePreview} alt="source preview" />
            </div>
          )}

          <div className="settings-block">
            <h3>Render settings</h3>
            <label>
              <span>Prompt</span>
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <label>
              <span>Elevation</span>
              <input
                type="range"
                min={-30}
                max={60}
                step={5}
                value={elevation}
                onChange={(e) => setElevation(Number(e.target.value))}
              />
              <em>{elevation} deg</em>
            </label>
            <label>
              <span>Distance</span>
              <input
                type="range"
                min={0.6}
                max={1.4}
                step={0.1}
                value={distance}
                onChange={(e) => setDistance(Number(e.target.value))}
              />
              <em>{distance.toFixed(1)}</em>
            </label>
            <label>
              <span>Guidance</span>
              <input
                type="range"
                min={1}
                max={8}
                step={0.1}
                value={guidanceScale}
                onChange={(e) => setGuidanceScale(Number(e.target.value))}
              />
              <em>{guidanceScale.toFixed(1)}</em>
            </label>
            <label>
              <span>Steps</span>
              <input
                type="range"
                min={8}
                max={28}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
              />
              <em>{steps}</em>
            </label>
            <label>
              <span>Resolution</span>
              <div className="inline-inputs">
                <input
                  type="number"
                  min={256}
                  max={1024}
                  step={64}
                  value={width}
                  onChange={(e) => setWidth(Number(e.target.value))}
                />
                <span>x</span>
                <input
                  type="number"
                  min={256}
                  max={1024}
                  step={64}
                  value={height}
                  onChange={(e) => setHeight(Number(e.target.value))}
                />
              </div>
            </label>
            <label className="toggle">
              <span>Randomize seed</span>
              <input type="checkbox" checked={randomizeSeed} onChange={(e) => setRandomizeSeed(e.target.checked)} />
            </label>
            {!randomizeSeed && (
              <label>
                <span>Seed</span>
                <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
              </label>
            )}
          </div>

          <button type="button" className="primary-button" onClick={handleRenderAll} disabled={!sourcePayload || isRunning}>
            {isRunning ? 'Rendering...' : 'Render all angles'}
          </button>
        </section>

        <section className="camera-stage">
          <div className="stage-header">
            <div>
              <h2>Spin viewer</h2>
              <p>Drag left or right to rotate. Use arrow keys for fine control.</p>
            </div>
            <div className="angle-indicator">
              <span>{angleLabels[selectedIndex] ?? `${selectedIndex + 1} / ${ANGLE_COUNT}`}</span>
              <small>
                {completedCount}/{totalFrames} ready
              </small>
            </div>
          </div>

          <div
            className={`stage-viewer ${isDragging ? 'is-dragging' : ''}`}
            style={viewerStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerLeave={stopDragging}
            onKeyDown={handleKeyDown}
            tabIndex={0}
            role="slider"
            aria-label="Spin viewer"
            aria-valuemin={0}
            aria-valuemax={ANGLE_PRESETS.length - 1}
            aria-valuenow={selectedIndex}
          >
            <div className="viewer-progress" aria-hidden="true" />
            {displayImage ? <img src={displayImage} alt={`view-${selectedIndex}`} /> : <div className="stage-placeholder">{emptyMessage}</div>}
            <div className="viewer-hud">
              <span>{isRunning ? `Rendering ${completedCount}/${totalFrames}` : statusMessage}</span>
              <span>{angleLabels[selectedIndex] ?? `${selectedIndex + 1} / ${ANGLE_COUNT}`}</span>
            </div>
            {!isDragging && results.length > 1 && <div className="viewer-hint">Drag to rotate</div>}
          </div>

          <div className="stage-controls">
            <input
              type="range"
              min={0}
              max={ANGLE_PRESETS.length - 1}
              value={selectedIndex}
              onChange={(e) => handleSelect(Number(e.target.value))}
            />
            <span>
              {selectedIndex + 1} / {ANGLE_PRESETS.length}
            </span>
          </div>

          <div className="angle-strip">
            {results.length === 0 && <div className="strip-empty">Upload an image to queue the first render.</div>}
            {results.map((result, index) => (
              <button
                type="button"
                key={result.id}
                className={`angle-card ${index === selectedIndex ? 'is-active' : ''}`}
                onClick={() => handleSelect(index)}
              >
                <div className="angle-card__meta">
                  <span>{angleLabels[index]}</span>
                  <span>{result.status}</span>
                </div>
                <div className="angle-card__image">
                  {result.image ? <img src={result.image} alt={`angle-${result.azimuth}`} /> : <span>Waiting</span>}
                </div>
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
