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
draft: false
---
```

## ライセンス

コードは [MIT License](LICENSE)（Fuwari に準拠）、記事は [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) で公開しています。
