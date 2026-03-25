# Folder Layout

```text
GPURender/
  README.md
  docs/
    folder-layout.md
  schema/
    talk-video-project.schema.json
  renderers/
    remotion/
      README.md
    resolve/
      README.md
    gpu/
      README.md
  examples/
    public-safe-sample/
      project.json
```

## 役割

- `schema/`
  - 共通 `project.json` の JSON Schema

- `renderers/remotion/`
  - 共通データから Remotion 用データを生成する adapter

- `renderers/resolve/`
  - 共通データから OTIO / XML / SRT / asset bundle を出す exporter

- `renderers/gpu/`
  - 会話動画専用 GPU renderer

- `examples/`
  - 公開して問題ない最小サンプル
