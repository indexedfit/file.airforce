const views = ['home', 'drops', 'rooms', 'peers']

export function currentView() {
  const sp = new URLSearchParams(location.search)
  const v = sp.get('view')
  return views.includes(v) ? v : 'home'
}

export function goto(view, extras = {}) {
  const sp = new URLSearchParams(location.search)
  sp.set('view', view)
  for (const [k, v] of Object.entries(extras)) sp.set(k, v)
  history.pushState(null, '', `?${sp.toString()}`)
  renderView()
}

export function renderView() {
  const v = currentView()
  for (const name of views) {
    const el = document.getElementById(`view-${name}`)
    if (el) el.hidden = name !== v
  }
}

export function bindNavLinks() {
  document.querySelectorAll('a[data-link]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      const url = new URL(a.href)
      goto(url.searchParams.get('view') || 'home')
    })
  })
  window.addEventListener('popstate', renderView)
}

