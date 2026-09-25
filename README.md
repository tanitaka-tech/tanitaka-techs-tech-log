# tanitaka-techのテックログ

tanitaka-tech の技術ブログです。

🌐 https://tanitaka-tech.github.io/tanitaka-techs-tech-log/

[Astro](https://astro.build) 製のブログテンプレート [Fuwari](https://github.com/saicaca/fuwari) をベースにしています。

## 開発

```sh
pnpm install
pnpm dev          # http://localhost:4321/tanitaka-techs-tech-log/ で起動
pnpm new-post <filename>  # src/content/posts/ に記事を作成
pnpm build        # dist/ にビルド（検索インデックスも生成）
pnpm lint         # Biome でチェック・自動修正
```

`develop` ブランチへの push で GitHub Pages に自動デプロイされます。

## 記事の Front-matter

```yaml
---
title: 記事タイトル
published: 2026-01-01
updated: 2026-01-02      # 任意
description: 記事の概要   # 任意
image: ./cover.jpg       # 任意。OGP画像にも使われます
tags: [Astro, Blog]
category: 技術
canonical: https://zenn.dev/...  # 任意。他サイトとのクロスポスト時の正規URL
draft: false
---
```

## デイリーダイジェスト（自動生成記事）

X・YouTube・Steam から直近24時間に伸びた投稿を集め、カテゴリごとに埋め込みをカルーセルで並べた記事を作ります。候補の確認・ブロック・重みづけ・添削は手元で Claude Code と会話しながら行い、確認が済んだものだけを PR 経由で公開します。

- 出力先: `src/content/posts/daily-digest/YYYY-MM-DD.md`
- 生成記事には `自動生成` タグが付きます（手書きの記事と区別するため）
- 設定（検索キーワード・X の読み取り上限・掲載件数など）: `scripts/daily-digest/config.yaml`
- 人間の判断（ブロック・重みづけ・推し）: `scripts/daily-digest/curation.yaml`
- 選定基準・タイトルの付け方: `scripts/daily-digest/selection-guide.md`
- 投稿本文などの生データは `.digest-cache/` に保存され、コミットされません

### 作り方（Claude Code）

```sh
cp .env.example .env   # X_BEARER_TOKEN / YOUTUBE_API_KEY を記入
```

Claude Code で `/digest` を実行すると、次の順に進みます。

1. **収集**: 実行時点から24時間以内の投稿・動画（`config.yaml` の `collect.windowHours`）を集めて `.digest-cache/<date>/` に保存する。`<date>` は記事の日付（実行日）。X は従量課金なので、保存済みなら取り直さない。前の記事に載せたものは自動で候補から外れる
2. **確認**: `curation.yaml` を適用した候補を番号付きで見せる。Claude がおすすめ（✅）と気になる点（⚠️）を付けるが、除外はしない
3. **重みづけ**: 「#3 の人ブロック」「VTuber 少し強めに」「#9 は推し」などと指示すると、`curation.yaml` にルールが追加される。「今回だけ外して」は選定だけを直す
4. **選定・添削**: 選んだ項目とタイトル・説明を `selection.json` に書いて記事を生成し、`pnpm dev` でプレビューする。タイトルや項目の直しも会話で指示する
5. **公開**: 「公開して」と伝えると、記事と `curation.yaml` をコミットして PR を作り、CI が通ったらマージする（develop へのマージで公開）

### curation.yaml

| action | 効果 |
|---|---|
| `block` | 候補から外す |
| `weight` | スコアに倍率を掛ける（当たったルールの倍率はすべて掛け合わせる） |
| `pin` | スコアや block に関係なく候補一覧に必ず残す |
| `ignore-sharer` | X で YouTube を貼ったアカウントを共有者数に数えない（宣伝・bot 対策） |

条件（`match`）には個別の投稿（`key`）、投稿者（`author`。X はユーザーID、YouTube はチャンネルID）、ジャンル（`genre`）、本文の正規表現（`text`）を書けます。複数書くとすべてを満たす候補に当たります。`reason` と `added` は必須で、`until` を書くとその日を過ぎたら効かなくなります。ルールは記事と一緒にコミットされるので、git の履歴で経緯を追えます。

### コマンド

`/digest` スキルは次のコマンドを順に呼んでいます。手で実行することもできます。`--date` は記事の日付で、省くと今日です（collect は今日しか指定できません。review 以降は過去の日付の作りかけの記事にも使えます）。

```sh
pnpm digest collect                           # 直近24時間の候補を集める（--force で取り直し、--x-limit 100 で X の読み取りを抑える）
pnpm digest review --date 2026-09-25          # 候補一覧（--all で除外・圏外も表示）
pnpm digest curate block author:#3 --reason 懸賞アカウント
pnpm digest curate weight genre:vtuber 1.5 --reason 好み --until 2026-10-31
pnpm digest curate pin '#9' --reason 推し
pnpm digest curate ignore-sharer @someone --reason bot
pnpm digest curate unset genre:vtuber         # 同じ条件のルールを消す
pnpm digest curate list                       # ルールの一覧
pnpm digest select --llm                      # API の LLM に selection.json を作らせる（任意。API キーが必要）
pnpm digest select --mock                     # スコア上位を機械的に選ぶ（動作確認用）
pnpm digest render --date 2026-09-25          # selection.json から記事を書き出す
pnpm digest publish --date 2026-09-25         # build → PR 作成 → CI 通過後にマージ（--no-merge で PR だけ）
pnpm digest:check-deleted                     # 削除・非公開になった掲載項目を記事から取り除く
```

curate の対象は `#3`（候補）、`author:#3`（候補の投稿者）、`x:123` / `youtube:abc`（キー）、`author:x:<ユーザーID>`、`genre:<ジャンルID>`、`text:<正規表現>` で指定します。`--genre <ジャンルID>` を付けると、そのジャンルの中だけで効くルールになります。候補の番号は日付ごとに固定されるので、ルールを足して並びが変わっても同じ番号で指定できます。

`collect --fixture <candidates.json>` を使うと、保存済みの候補データで API を呼ばずに試せます。

### 音楽・動画の集め方

YouTube を再生数順に検索するだけだと海外の大型コンテンツばかりになるので、次の3つで日本のオタク界隈の曲・動画に寄せています。

- **仮名フィルタと検索の分割**: タイトルかチャンネル名に仮名がある動画だけを残し（`youtube.requireKana`）、アニソン・ボカロ・VTuber などを別々に検索して候補を確保する。記事では1つのカルーセルにまとめ、上部の区切り（`step`）で切り替えられる。区切りの中はスコア順
- **X での共有者数**（`x-music`）: X で YouTube リンクを貼ったアカウントの数（重複なし）で並べる。宣伝や bot のアカウントは `ignore-sharer` で数えないようにできる
- **X リスト**（`x-list-music`）: 自分で作った公開リストのメンバーが貼った動画を拾う。`config.yaml` の `listId` にリストの ID（`x.com/i/lists/<ID>`）を入れると有効になり、以降はリストのメンバーを編集するだけで好みを調整できる

### 削除された投稿の確認

掲載済みの投稿・動画が削除や非公開になっていないかは、Actions → **Digest Check Deleted** から確認できます（Secrets に `X_BEARER_TOKEN` / `YOUTUBE_API_KEY` が必要）。該当項目を記事から取り除く PR が作られます。

## ライセンス

コードは [MIT License](LICENSE)（Fuwari に準拠）、記事は [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) で公開しています。
