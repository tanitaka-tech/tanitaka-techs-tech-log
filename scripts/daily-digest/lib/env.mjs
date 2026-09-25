/** ローカル実行用に .env を読み込む。既に設定済みの環境変数（Actions の Secrets など）は上書きしない */
export function loadDotEnv() {
  try {
    process.loadEnvFile(".env")
  } catch (e) {
    if (e.code !== "ENOENT") throw e
  }
}
