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

X・YouTube・Steam からその日（JST）に伸びた投稿を集め、LLM（Claude・GPT・Gemini のうち使えるもの）が掲載する投稿を選び、カテゴリごとに埋め込みをカルーセルで並べた記事の下書きを作ります。公開前に必ず人間がレビューし、PR をマージしたときだけ公開されます。

- 出力先: `src/content/posts/daily-digest/YYYY-MM-DD.md`
- 生成記事には `自動生成` タグが付きます（手書きの記事と区別するため）
- 設定（検索キーワード・X の読み取り上限・掲載件数など）: `scripts/daily-digest/config.yaml`
- 投稿本文などの生データは `.digest-cache/` に保存され、コミットされません

### 音楽・動画の集め方

YouTube を再生数順に検索するだけだと海外の大型コンテンツばかりになるので、次の3つで日本のオタク界隈の曲・動画に寄せています。

- **仮名フィルタと検索の分割**: タイトルかチャンネル名に仮名がある動画だけを残し（`youtube.requireKana`）、アニソン・ボカロ・VTuber などを別々に検索して候補を確保する。記事では1つのカルーセルにまとめ、上部の区切り（`step`）で切り替えられる。区切りの中はスコア順
- **X での共有者数**（`x-music`）: X で YouTube リンクを貼ったアカウントの数（重複なし）で並べる
- **X リスト**（`x-list-music`）: 自分で作った公開リストのメンバーが貼った動画を拾う。`config.yaml` の `listId` にリストの ID（`x.com/i/lists/<ID>`）を入れると有効になり、以降はリストのメンバーを編集するだけで好みを調整できる

### ローカルで実行

```sh
cp .env.example .env   # X_BEARER_TOKEN / YOUTUBE_API_KEY と、LLM の API キー（1つ以上）を記入

pnpm digest                        # 今日分を生成
pnpm digest --date 2026-09-25      # 対象日を指定
pnpm digest --x-limit 100          # X の読み取り件数を抑えて試す（80以上推奨）
pnpm digest --llm gemini,openai    # 使う LLM と順番を指定（既定は config.yaml の llm.providers 順）
pnpm digest --mock-llm             # LLM を呼ばずに収集と記事の組み立てだけ試す
pnpm digest --fixture .digest-cache/2026-09-25/candidates.json --selection selection.json
                                   # 収集済みの候補と手書きの選定結果から記事を作る
pnpm digest:check-deleted          # 削除・非公開になった掲載項目を記事から取り除く
pnpm dev                           # 生成された記事を確認
```

### GitHub Actions で実行

リポジトリの Secrets に `X_BEARER_TOKEN` / `YOUTUBE_API_KEY` と、`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` のいずれか（複数あればフォールバックに使われる）を登録し、Settings → Actions → General で「Allow GitHub Actions to create and approve pull requests」を有効にしておきます。

1. Actions → **Daily Digest** → Run workflow（対象日は空なら今日）
2. `auto-digest` ラベル付きの PR が作られるので、チェックリストに沿ってレビュー
3. マージすると公開されます（3日以上放置された PR は次回実行時に自動でクローズ）

削除された投稿の確認は Actions → **Digest Check Deleted** から実行します。

## ライセンス

コードは [MIT License](LICENSE)（Fuwari に準拠）、記事は [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) で公開しています。
