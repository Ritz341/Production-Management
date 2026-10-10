import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const STUB = new URL('./stubs/supabaseClient.js', import.meta.url).href

export async function resolve(specifier, context, next) {
  if (/(^|\/)supabaseClient(\.js)?$/.test(specifier)) return { url: STUB, shortCircuit: true }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?jsx?$/.test(specifier) && context.parentURL) {
    const candidate = new URL(specifier + '.js', context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return { url: pathToFileURL(fileURLToPath(candidate)).href, shortCircuit: true }
  }
  return next(specifier, context)
}
