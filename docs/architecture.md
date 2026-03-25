# アーキテクチャ

GPURender v0 は、データと描画を明確に分離した 2 層構成で設計します。

## データ層

- `project.json` を唯一の入力として扱う
- `characters`, `timeline`, `style`, `sources`, `renderTargets` を起点に解釈
- 音声ファイルや字幕・口パクデータへの参照は `sources` で受け取り、renderer は参照パスを解決して使用

## 生成層

- 1 つの会話シーンテンプレートを読み込み、以下を描画
- 背景図形
- 中央カード
- 左右 2 キャラクターの立ち絵
- 下部字幕帯（固定高さ）
- 口パクと瞬きのフレーム制御
- BGM を含む音声との同時再生レイヤー

## 出力層

- フレーム単位または中間動画のどちらかを `ffmpeg` へ渡して固定エンコード
- NVIDIA 環境では `h264_nvenc` を使用

## 再現性

- `timeline.randomSeed` で演出ブレを抑制
- `timeline.colorProfile`、`subtitle` の字割りルールを renderer で揃える
- `renderTargets.*.outputPath` で結果の置き先を明示

## 依存関係方針

- 依存は小さく保つ
- 今後の v1 で `schema`, `shared`, `renderer`, `cli`, `examples` を分離しやすい構成に寄せる
