# GPURender

`GPURender` は、日本語で編集する会話動画ワークフローを維持しつつ、最終的に GPU レンダリングしやすい形へ流すための公開用ベースリポジトリです。

現時点の方針は 2 本立てです。

- 短期
  - 共通 `project.json` から `Resolve` 向けの OTIO / XML / SRT / asset bundle を出す
- 中長期
  - 共通 `project.json` から会話動画専用 GPU renderer へ流す

## 含めるもの

- renderer 非依存の共通スキーマ
- public-safe なサンプル案件
- Remotion / Resolve / GPU renderer へ分岐するためのフォルダ構成

## 含めないもの

- ローカル絶対パス
- 個別案件の私有資料
- 権利確認前の音声、BGM、立ち絵素材

## 構成

- [docs/folder-layout.md](./docs/folder-layout.md)
- [schema/talk-video-project.schema.json](./schema/talk-video-project.schema.json)
- [examples/public-safe-sample/project.json](./examples/public-safe-sample/project.json)

## ねらい

`Remotion の JSX` を唯一の正本にせず、会話、字幕、口パク、瞬き、カード、音声ミックス、出力先を `project.json` に寄せることで、編集体験とレンダリング実装を分離します。

## 現在の GPU renderer

現状の GPU renderer は `AgiDiscussion` 系レイアウトを対象に、次の要素を GPU 書き出し側へ寄せています。

- 口パクと瞬きに合わせた立ち絵切り替え
- cue ごとの中央カード差し替え
- cue ごとの右上ラベル差し替え
- cue ごとの字幕帯差し替え
- `h264_nvenc` による最終 mp4 出力
- `--cpu-temp-limit` と `--cooldown-ms` による低負荷運用

正確な見た目を保つため、案件ごとの `gpu-assets/cards`、`gpu-assets/top`、`gpu-assets/subtitles` はローカル専用資産として扱います。公開 repo には仕組みだけを含めます。
