process.env.REDROB_DB = ":memory:"
// Gate the console /models fetch off so core tests stay offline/deterministic; the
// ModelsDev.Service then serves the static console fallback catalog (redrob/auto and the rest of
// CONSOLE_MODELS).
process.env.REDROB_DISABLE_MODELS_FETCH = "true"
