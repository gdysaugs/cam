type Env = {
  RUNPOD_API_KEY: string
  RUNPOD_ENDPOINT_URL?: string
  COMFY_ORG_API_KEY?: string
  RUNPOD_WORKER_MODE?: string
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const resolveEndpoint = (env: Env) => env.RUNPOD_ENDPOINT_URL?.replace(/\/$/, '')

type NodeMapEntry = {
  id: string
  input: string
}

type NodeMap = Partial<{
  image: NodeMapEntry
  prompt: NodeMapEntry
  seed: NodeMapEntry
  steps: NodeMapEntry
  cfg: NodeMapEntry
  width: NodeMapEntry
  height: NodeMapEntry
}>

const workflowUrl = new URL('./qwen-workflow.json', import.meta.url)
const nodeMapUrl = new URL('./qwen-node-map.json', import.meta.url)

let workflowCache: Record<string, unknown> | null = null
let nodeMapCache: NodeMap | null = null

const loadJson = async <T>(url: URL): Promise<T> => {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to load ${url.pathname}`)
  }
  return res.json() as Promise<T>
}

const getWorkflowTemplate = async () => {
  if (!workflowCache) {
    workflowCache = await loadJson<Record<string, unknown>>(workflowUrl)
  }
  return workflowCache
}

const getNodeMap = async () => {
  if (!nodeMapCache) {
    nodeMapCache = await loadJson<NodeMap>(nodeMapUrl)
  }
  return nodeMapCache
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const stripDataUrl = (value: string) => {
  const comma = value.indexOf(',')
  if (value.startsWith('data:') && comma !== -1) {
    return value.slice(comma + 1)
  }
  return value
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

const fetchImageBase64 = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error('Failed to fetch image_url.')
  }
  const buffer = await res.arrayBuffer()
  return arrayBufferToBase64(buffer)
}

const setInputValue = (
  workflow: Record<string, any>,
  entry: NodeMapEntry,
  value: unknown,
) => {
  const node = workflow[entry.id]
  if (!node?.inputs) {
    throw new Error(`Node ${entry.id} not found in workflow.`)
  }
  node.inputs[entry.input] = value
}

const applyNodeMap = (
  workflow: Record<string, any>,
  nodeMap: NodeMap,
  values: Record<string, unknown>,
) => {
  for (const [key, value] of Object.entries(values)) {
    const entry = nodeMap[key as keyof NodeMap]
    if (!entry || value === undefined || value === null) continue
    setInputValue(workflow, entry, value)
  }
}

export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: corsHeaders })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url)
  const id = url.searchParams.get('id')
  if (!id) {
    return jsonResponse({ error: 'id is required.' }, 400)
  }
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RUNPOD_ENDPOINT_URL is not set.' }, 500)
  }
  const upstream = await fetch(`${endpoint}/status/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${env.RUNPOD_API_KEY}` },
  })
  const data = await upstream.text()
  return new Response(data, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.RUNPOD_API_KEY) {
    return jsonResponse({ error: 'RUNPOD_API_KEY is not set.' }, 500)
  }

  const endpoint = resolveEndpoint(env)
  if (!endpoint) {
    return jsonResponse({ error: 'RUNPOD_ENDPOINT_URL is not set.' }, 500)
  }

  const payload = await request.json().catch(() => null)
  if (!payload) {
    return jsonResponse({ error: 'Invalid request body.' }, 400)
  }

  const input = payload.input ?? payload
  const imageValue = input?.image_base64 ?? input?.image ?? input?.image_url
  if (!imageValue) {
    return jsonResponse({ error: 'image is required.' }, 400)
  }

  let imageBase64 = ''
  try {
    imageBase64 =
      typeof input?.image_url === 'string' && input.image_url
        ? await fetchImageBase64(input.image_url)
        : stripDataUrl(String(imageValue))
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Failed to read image.' }, 400)
  }

  if (!imageBase64) {
    return jsonResponse({ error: 'image is empty.' }, 400)
  }

  const prompt = String(input?.prompt ?? input?.text ?? '')
  const steps = Number(input?.num_inference_steps ?? input?.steps ?? 4)
  const guidanceScale = Number(input?.guidance_scale ?? input?.cfg ?? 1)
  const width = Number(input?.width ?? 768)
  const height = Number(input?.height ?? 768)
  const workerMode = String(input?.worker_mode ?? input?.mode ?? env.RUNPOD_WORKER_MODE ?? '').toLowerCase()
  const useComfyUi = workerMode === 'comfyui' || Boolean(input?.workflow)

  if (useComfyUi) {
    const seed = input?.randomize_seed
      ? Math.floor(Math.random() * 2147483647)
      : Number(input?.seed ?? 0)
    const imageName = String(input?.image_name ?? 'input.png')
    const workflow = input?.workflow ? clone(input.workflow) : clone(await getWorkflowTemplate())
    if (!workflow || Object.keys(workflow).length === 0) {
      return jsonResponse({ error: 'workflow.json is empty. Export a ComfyUI API workflow.' }, 500)
    }

    const nodeMap = await getNodeMap().catch(() => null)
    const hasNodeMap = nodeMap && Object.keys(nodeMap).length > 0
    const shouldApplyNodeMap = input?.apply_node_map !== false

    if (shouldApplyNodeMap && hasNodeMap) {
      applyNodeMap(workflow as Record<string, any>, nodeMap, {
        image: imageName,
        prompt,
        seed,
        steps,
        cfg: guidanceScale,
        width,
        height,
      })
    } else if (!input?.workflow) {
      return jsonResponse({ error: 'node_map.json is empty. Provide a node map or send workflow directly.' }, 500)
    }

    const comfyKey = String(input?.comfy_org_api_key ?? env.COMFY_ORG_API_KEY ?? '')
    const runpodInput: Record<string, unknown> = {
      workflow,
      images: [{ name: imageName, image: imageBase64 }],
    }
    if (comfyKey) {
      runpodInput.comfy_org_api_key = comfyKey
    }

    const upstream = await fetch(`${endpoint}/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ input: runpodInput }),
    })
    const data = await upstream.text()
    return new Response(data, {
      status: upstream.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const runpodInput = {
    image_base64: imageBase64,
    prompt,
    guidance_scale: guidanceScale,
    num_inference_steps: steps,
    width,
    height,
    seed: Number(input?.seed ?? 0),
    randomize_seed: Boolean(input?.randomize_seed ?? false),
  } as Record<string, unknown>

  const views = Array.isArray(input?.views) ? input.views : Array.isArray(input?.angles) ? input.angles : null
  if (views) {
    runpodInput.views = views
    runpodInput.angles = views
  } else {
    runpodInput.azimuth = input?.azimuth
    runpodInput.elevation = input?.elevation
    runpodInput.distance = input?.distance
  }

  const upstream = await fetch(`${endpoint}/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RUNPOD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: runpodInput }),
  })
  const data = await upstream.text()
  return new Response(data, {
    status: upstream.status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
