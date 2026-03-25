# Schema

GPURender は、共通スキーマを元に `project.json` から読み込みます。
最小要件を満たす項目は以下です。

- `schemaVersion`
- `project`
- `timeline`
- `characters`
- `style`
- `sources`
- `renderTargets`

補助として以下を定義します。

- `sceneOverrides`
- `lineOverrides`

## 推奨フィールド（v0）

- `timeline`
  - `startTimecode`
  - `randomSeed`
  - `colorProfile`
  - `audioMix`
- `style.subtitleBand`
  - `maxLines`
  - `lineBreakRule`
- `renderTargets`
  - `outputPath`（出力先の明示）

v0 では、同一テンプレート前提のため、`schema` の全項目を受け取るよりも、
「必要な項目を必ず検証し、未対応項目は将来バージョンへ移譲する」運用にします。
