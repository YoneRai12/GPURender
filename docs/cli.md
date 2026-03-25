# CLI

v0 は最小 CLI 2 本を想定します。

```bash
gpu-render validate --project ./examples/public-safe-sample/project.json
gpu-render render --project ./examples/public-safe-sample/project.json --out ./out/public-safe-sample-gpu.mp4
```

`render` は以下を行います。

- `project.json` の読み込み
- スキーマ検証
- renderer 選択（現時点は会話テンプレート 1 種）
- dry-run plan の保存
- `ffmpeg + h264_nvenc` による GPU mp4 出力
- `--cpu-temp-limit` と `--cooldown-ms` によるセグメント前クールダウン
- ローカルに `gpu-assets/cards`、`gpu-assets/top`、`gpu-assets/subtitles` があれば優先利用

`validate` は以下を行います。

- JSON 形式と必須キーの確認
- 音声・画像パスの存在チェック
- timeline と字幕ブロックの基本整合性チェック

## 出力

- 既定エンコーダは `h264_nvenc` を優先
- 環境差異により fallback の方針は CLI 実装側で扱う

## 温度制御オプション

```bash
gpu-render render ^
  --project ./examples/public-safe-sample/project.json ^
  --out ./out/public-safe-sample-gpu.mp4 ^
  --cpu-temp-limit 85 ^
  --cooldown-ms 3000 ^
  --segment-seconds 3
```

CPU 温度センサーが取得できる環境では、しきい値を超えたときに次のセグメント開始前で待機します。

## ローカル資産フック

`AgiDiscussion` 系の移植では、案件ごとの見た目差を吸収するためにプロジェクト直下の `gpu-assets` を参照します。

- `gpu-assets/cards/card-01.png`
- `gpu-assets/top/top-01.png`
- `gpu-assets/subtitles/subtitle-01.png`

これらはローカル復元用の案件資産であり、公開 repo には含めない前提です。

## 既知の制約

- 実行には `ffmpeg` を別途用意する必要があります
- GPU 固有の最適化は利用環境依存
