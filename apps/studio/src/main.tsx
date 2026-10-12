import "@redrob-labs/ui/tokens.css"
import "@redrob-labs/ui/preflight.css"
import "@redrob-labs/ui/styles.css"
import "@xterm/xterm/css/xterm.css"
import "./styles.css"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"

const queries = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2_000 } },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
