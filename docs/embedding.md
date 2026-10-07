# Embedding providers

Local first: **EmbeddingGemma** (`embeddinggemma-2`) through Ollama, LM Studio,
or llama.cpp. Remote providers (Google Gemini / Vertex, OpenAI-compatible) are
optional. The prompt hook keeps using FTS unless `injection.useEmbeddings` is
enabled; `memctl embed` / `memctl semantic` work independently.

## Local first (recommended)

```bash
# Ollama
ollama pull embeddinggemma-2        # or: ollama pull embeddinggemma (check `ollama list`)
memctl embedding preset local       # baseUrl http://127.0.0.1:11434/v1, model embeddinggemma-2
memctl embed --check                # verifies endpoint + prints dimensions
memctl embed --limit 200
memctl semantic "缓存设计"
```

```bash
# LM Studio（本地 server 开启 OpenAI 兼容端点）
memctl embedding preset lmstudio    # baseUrl http://127.0.0.1:1234/v1

# llama.cpp server
# 手动配置：provider=local, baseUrl=http://127.0.0.1:8080/v1, model=<served name>
```

Notes:

- The model name must match what the runtime serves. Verify with
  `curl http://127.0.0.1:11434/v1/models` or `ollama list`; change
  `embedding.model` if your tag differs (for example `embeddinggemma:2b`).
- No API key is needed for local endpoints.
- To blend memory with prompts, add `"injection": { "useEmbeddings": true }`.

## Provider matrix

| provider | endpoint | auth | notes |
|---|---|---|---|
| `local` | `{baseUrl}/embeddings` | none | Ollama / LM Studio / llama.cpp, default model `embeddinggemma-2` |
| `openai` | `{baseUrl}/embeddings` | `Authorization: Bearer` | any OpenAI-compatible service |
| `google` | `{baseUrl}/v1beta/models/{model}:batchEmbedContents` | `x-goog-api-key` | Gemini API (AI Studio key) |
| `vertex` | `{baseUrl}/v1/projects/.../publishers/google/models/{model}:predict` | `Authorization: Bearer` | Vertex AI, needs project + access token |
| `custom` | same as `openai` | optional | self-hosted compatible gateways |

`provider` is inferred from `baseUrl` (`googleapis.com` → `google`) and can be
set explicitly.

## Google Gemini API (recommended for Google)

```json
{
  "embedding": {
    "enabled": true,
    "provider": "google",
    "baseUrl": "https://generativelanguage.googleapis.com",
    "model": "gemini-embedding-001",
    "apiKey": "AIza...",
    "dimensions": 1536
  },
  "injection": { "useEmbeddings": true }
}
```

- `gemini-embedding-001` is the current GA model; 768 / 1536 / 3072 output
  dimensions are supported (`dimensions` above).
- Stored turns use `RETRIEVAL_DOCUMENT`, queries use `RETRIEVAL_QUERY`
  automatically. Override with `embedding.taskType` if needed.
- When Google publishes a newer model, change `embedding.model` only.

Get a key at <https://aistudio.google.com/apikey>.

## Google Vertex AI

```json
{
  "embedding": {
    "enabled": true,
    "provider": "vertex",
    "baseUrl": "https://us-central1-aiplatform.googleapis.com",
    "model": "gemini-embedding-001",
    "project": "my-gcp-project",
    "location": "us-central1",
    "apiKey": "<access-token>",
    "dimensions": 1536
  }
}
```

Access tokens expire (~1 hour). Generate one with:

```bash
gcloud auth print-access-token
```

## OpenAI-compatible

```json
{
  "embedding": {
    "enabled": true,
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "text-embedding-3-small",
    "apiKey": "sk-...",
    "dimensions": 1536
  }
}
```

## Usage

```bash
memctl embed --limit 200     # embed pending turns (skips already embedded)
memctl semantic "缓存设计"    # cosine search over embeddings
```

With `injection.useEmbeddings: true`, the prompt hook re-ranks FTS candidates
with the query embedding; any failure falls back to the FTS order.

Notes:

- Embeddings live in the local SQLite database (`embeddings` table); vectors
  are stored as float32 blobs.
- Changing the model or dimension requires re-embedding: delete rows for the
  old model (`sqlite3 ~/.llm-memory/db/memory.db "delete from embeddings where model != '<new>'"`)
  and run `memctl embed` again.
