require("../env").loadEnv();

const defaultProvider = process.env.NODE_ENV === "production" ? "supabase" : "json";
const provider = (process.env.DATABASE_PROVIDER || defaultProvider).toLowerCase();

function adapter() {
  if (provider === "json") return require("./json-adapter");
  if (provider === "supabase" || provider === "postgres") return require("./supabase-adapter");
  throw new Error(`Unsupported DATABASE_PROVIDER=${provider}. Use json or supabase.`);
}

module.exports = adapter();
