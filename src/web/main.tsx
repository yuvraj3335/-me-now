import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

/*
 * The boundary is outside `App`, not inside it.
 *
 * `App` decides which page to render, including the lazily-loaded terminal, and
 * a rejected `lazy()` import is re-thrown from wherever it was awaited — which
 * is inside `App`'s own render. A boundary nested any deeper would be unmounted
 * by the same throw it was there to catch, which is how this product came to
 * answer a failed chunk load with an empty `<div id="root">` and nothing else.
 *
 * Nothing else goes out here. One boundary at the root catches everything and
 * says so honestly; a boundary per route would let a broken page look like an
 * empty one, which is the failure mode this whole pass is about.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
