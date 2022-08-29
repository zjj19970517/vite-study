import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import {
  // createDebugger,
  isExternalUrl,
  asyncReplace,
  cleanUrl,
  generateCodeFrame,
  isDataUrl,
  isObject,
  normalizePath,
  processSrcSet,
  parseRequest,
  combineSourcemaps
} from '../utils'
import type { Plugin } from '../plugin'
import type { ResolvedConfig } from '../config'
import postcssrc from 'postcss-load-config'
import type {
  ExistingRawSourceMap,
  NormalizedOutputOptions,
  OutputChunk,
  RenderedChunk,
  RollupError,
  SourceMapInput
} from 'rollup'
import { dataToEsm } from '@rollup/pluginutils'
import colors from 'picocolors'
import { CLIENT_PUBLIC_PATH } from '../constants'
import type { ResolveFn, ViteDevServer } from '../'
import {
  getAssetFilename,
  assetUrlRE,
  fileToUrl,
  checkPublicFile
} from './asset'
import MagicString from 'magic-string'
import type * as Postcss from 'postcss'
import type Sass from 'sass'
// We need to disable check of extraneous import which is buggy for stylus,
// and causes the CI tests fail, see: https://github.com/vitejs/vite/pull/2860
import type Stylus from 'stylus' // eslint-disable-line node/no-extraneous-import
import type Less from 'less'
import type { Alias } from 'types/alias'
import type { ModuleNode } from '../server/moduleGraph'
import { transform, formatMessages } from 'esbuild'
import { addToHTMLProxyTransformResult } from './html'
import { injectSourcesContent, getCodeWithSourcemap } from '../server/sourcemap'
import type { RawSourceMap } from '@ampproject/remapping'

// const debug = createDebugger('vite:css')

export interface CSSOptions {
  /**
   * https://github.com/css-modules/postcss-modules
   */
  modules?: CSSModulesOptions | false
  preprocessorOptions?: Record<string, any>
  postcss?:
    | string
    | (Postcss.ProcessOptions & {
        plugins?: Postcss.Plugin[]
      })
}

export interface CSSModulesOptions {
  getJSON?: (
    cssFileName: string,
    json: Record<string, string>,
    outputFileName: string
  ) => void
  scopeBehaviour?: 'global' | 'local'
  globalModulePaths?: RegExp[]
  generateScopedName?:
    | string
    | ((name: string, filename: string, css: string) => string)
  hashPrefix?: string
  /**
   * default: null
   */
  localsConvention?:
    | 'camelCase'
    | 'camelCaseOnly'
    | 'dashes'
    | 'dashesOnly'
    | null
}

const cssLangs = `\\.(css|less|sass|scss|styl|stylus|pcss|postcss)($|\\?)`
const cssLangRE = new RegExp(cssLangs)
const cssModuleRE = new RegExp(`\\.module${cssLangs}`)
const directRequestRE = /(\?|&)direct\b/
const htmlProxyRE = /(\?|&)html-proxy\b/
const commonjsProxyRE = /\?commonjs-proxy/
const inlineRE = /(\?|&)inline\b/
const inlineCSSRE = /(\?|&)inline-css\b/
const usedRE = /(\?|&)used\b/

const enum PreprocessLang {
  less = 'less',
  sass = 'sass',
  scss = 'scss',
  styl = 'styl',
  stylus = 'stylus'
}
const enum PureCssLang {
  css = 'css'
}
type CssLang = keyof typeof PureCssLang | keyof typeof PreprocessLang

export const isCSSRequest = (request: string): boolean =>
  cssLangRE.test(request)

export const isDirectCSSRequest = (request: string): boolean =>
  cssLangRE.test(request) && directRequestRE.test(request)

export const isDirectRequest = (request: string): boolean =>
  directRequestRE.test(request)

const cssModulesCache = new WeakMap<
  ResolvedConfig,
  Map<string, Record<string, string>>
>()

export const removedPureCssFilesCache = new WeakMap<
  ResolvedConfig,
  Map<string, RenderedChunk>
>()

const postcssConfigCache = new WeakMap<
  ResolvedConfig,
  PostCSSConfigResult | null
>()

/**
 * Plugin applied before user plugins
 */
export function cssPlugin(config: ResolvedConfig): Plugin {
  let server: ViteDevServer
  let moduleCache: Map<string, Record<string, string>>

  const resolveUrl = config.createResolver({
    preferRelative: true,
    tryIndex: false,
    extensions: []
  })
  const atImportResolvers = createCSSResolvers(config)

  return {
    name: 'vite:css',

    configureServer(_server) {
      server = _server
    },

    buildStart() {
      // Ensure a new cache for every build (i.e. rebuilding in watch mode)
      moduleCache = new Map<string, Record<string, string>>()
      cssModulesCache.set(config, moduleCache)

      removedPureCssFilesCache.set(config, new Map<string, RenderedChunk>())
    },

    async transform(raw, id, options) {
      if (!isCSSRequest(id) || commonjsProxyRE.test(id)) {
        return
      }
      const ssr = options?.ssr === true

      const urlReplacer: CssUrlReplacer = async (url, importer) => {
        if (checkPublicFile(url, config)) {
          return config.base + url.slice(1)
        }
        const resolved = await resolveUrl(url, importer)
        if (resolved) {
          return fileToUrl(resolved, config, this)
        }
        return url
      }

      const {
        code: css,
        modules,
        deps,
        map
      } = await compileCSS(
        id,
        raw,
        config,
        urlReplacer,
        atImportResolvers,
        server
      )
      if (modules) {
        moduleCache.set(id, modules)
      }

      // track deps for build watch mode
      if (config.command === 'build' && config.build.watch && deps) {
        for (const file of deps) {
          this.addWatchFile(file)
        }
      }

      // dev
      if (server) {
        // server only logic for handling CSS @import dependency hmr
        const { moduleGraph } = server
        const thisModule = moduleGraph.getModuleById(id)
        if (thisModule) {
          // CSS modules cannot self-accept since it exports values
          const isSelfAccepting = !modules && !inlineRE.test(id)
          if (deps) {
            // record deps in the module graph so edits to @import css can trigger
            // main import to hot update
            const depModules = new Set<string | ModuleNode>()
            for (const file of deps) {
              depModules.add(
                isCSSRequest(file)
                  ? moduleGraph.createFileOnlyEntry(file)
                  : await moduleGraph.ensureEntryFromUrl(
                      (
                        await fileToUrl(file, config, this)
                      ).replace(
                        (config.server?.origin ?? '') + config.base,
                        '/'
                      ),
                      ssr
                    )
              )
            }
            moduleGraph.updateModuleInfo(
              thisModule,
              depModules,
              // The root CSS proxy module is self-accepting and should not
              // have an explicit accept list
              new Set(),
              isSelfAccepting,
              ssr
            )
            for (const file of deps) {
              this.addWatchFile(file)
            }
          } else {
            thisModule.isSelfAccepting = isSelfAccepting
          }
        }
      }

      return {
        code: css,
        map
      }
    }
  }
}

/**
 * Plugin applied after user plugins
 */
export function cssPostPlugin(config: ResolvedConfig): Plugin {
  // styles initialization in buildStart causes a styling loss in watch
  const styles: Map<string, string> = new Map<string, string>()
  let pureCssChunks: Set<string>

  // when there are multiple rollup outputs and extracting CSS, only emit once,
  // since output formats have no effect on the generated CSS.
  let outputToExtractedCSSMap: Map<NormalizedOutputOptions, string>
  let hasEmitted = false

  return {
    name: 'vite:css-post',

    buildStart() {
      // Ensure new caches for every build (i.e. rebuilding in watch mode)
      pureCssChunks = new Set<string>()
      outputToExtractedCSSMap = new Map<NormalizedOutputOptions, string>()
      hasEmitted = false
    },

    async transform(css, id, options) {
      if (!isCSSRequest(id) || commonjsProxyRE.test(id)) {
        return
      }

      const inlined = inlineRE.test(id)
      const modules = cssModulesCache.get(config)!.get(id)
      const modulesCode =
        modules && dataToEsm(modules, { namedExports: true, preferConst: true })

      if (config.command === 'serve') {
        if (isDirectCSSRequest(id)) {
          return css
        } else {
          // server only
          if (options?.ssr) {
            return modulesCode || `export default ${JSON.stringify(css)}`
          }
          if (inlined) {
            return `export default ${JSON.stringify(css)}`
          }

          const sourcemap = this.getCombinedSourcemap()
          await injectSourcesContent(sourcemap, cleanUrl(id), config.logger)
          const cssContent = getCodeWithSourcemap('css', css, sourcemap)

          return [
            `import { updateStyle as __vite__updateStyle, removeStyle as __vite__removeStyle } from ${JSON.stringify(
              path.posix.join(config.base, CLIENT_PUBLIC_PATH)
            )}`,
            `const __vite__id = ${JSON.stringify(id)}`,
            `const __vite__css = ${JSON.stringify(cssContent)}`,
            `__vite__updateStyle(__vite__id, __vite__css)`,
            // css modules exports change on edit so it can't self accept
            `${
              modulesCode ||
              `import.meta.hot.accept()\nexport default __vite__css`
            }`,
            `import.meta.hot.prune(() => __vite__removeStyle(__vite__id))`
          ].join('\n')
        }
      }

      // build CSS handling ----------------------------------------------------

      // record css
      // cache css compile result to map
      // and then use the cache replace inline-style-flag when `generateBundle` in vite:build-html plugin
      const inlineCSS = inlineCSSRE.test(id)
      const query = parseRequest(id)
      const isHTMLProxy = htmlProxyRE.test(id)
      if (inlineCSS && isHTMLProxy) {
        addToHTMLProxyTransformResult(
          `${cleanUrl(id)}_${Number.parseInt(query!.index)}`,
          css
        )
        return `export default ''`
      }
      if (!inlined) {
        styles.set(id, css)
      }

      return {
        code:
          modulesCode ||
          (usedRE.test(id)
            ? `export default ${JSON.stringify(
                inlined ? await minifyCSS(css, config) : css
              )}`
            : `export default ''`),
        map: { mappings: '' },
        // avoid the css module from being tree-shaken so that we can retrieve
        // it in renderChunk()
        moduleSideEffects: inlined ? false : 'no-treeshake'
      }
    },

    async renderChunk(code, chunk, opts) {
      let chunkCSS = ''
      let isPureCssChunk = true
      const ids = Object.keys(chunk.modules)
      for (const id of ids) {
        if (
          !isCSSRequest(id) ||
          cssModuleRE.test(id) ||
          commonjsProxyRE.test(id)
        ) {
          isPureCssChunk = false
        }
        if (styles.has(id)) {
          chunkCSS += styles.get(id)
        }
      }

      if (!chunkCSS) {
        return null
      }

      // resolve asset URL placeholders to their built file URLs and perform
      // minification if necessary
      const processChunkCSS = async (
        css: string,
        {
          inlined,
          minify
        }: {
          inlined: boolean
          minify: boolean
        }
      ) => {
        // replace asset url references with resolved url.
        const isRelativeBase = config.base === '' || config.base.startsWith('.')
        css = css.replace(assetUrlRE, (_, fileHash, postfix = '') => {
          const filename = getAssetFilename(fileHash, config) + postfix
          chunk.viteMetadata.importedAssets.add(cleanUrl(filename))
          if (!isRelativeBase || inlined) {
            // absolute base or relative base but inlined (injected as style tag into
            // index.html) use the base as-is
            return config.base + filename
          } else {
            // relative base + extracted CSS - asset file will be in the same dir
            return `./${path.posix.basename(filename)}`
          }
        })
        // only external @imports should exist at this point - and they need to
        // be hoisted to the top of the CSS chunk per spec (#1845)
        if (css.includes('@import')) {
          css = await hoistAtImports(css)
        }
        if (minify && config.build.minify) {
          css = await minifyCSS(css, config)
        }
        return css
      }

      if (config.build.cssCodeSplit) {
        if (isPureCssChunk) {
          // this is a shared CSS-only chunk that is empty.
          pureCssChunks.add(chunk.fileName)
        }
        if (opts.format === 'es' || opts.format === 'cjs') {
          chunkCSS = await processChunkCSS(chunkCSS, {
            inlined: false,
            minify: true
          })
          // emit corresponding css file
          const fileHandle = this.emitFile({
            name: chunk.name + '.css',
            type: 'asset',
            source: chunkCSS
          })
          chunk.viteMetadata.importedCss.add(this.getFileName(fileHandle))
        } else if (!config.build.ssr) {
          // legacy build, inline css
          chunkCSS = await processChunkCSS(chunkCSS, {
            inlined: true,
            minify: true
          })
          const style = `__vite_style__`
          const injectCode =
            `var ${style} = document.createElement('style');` +
            `${style}.innerHTML = ${JSON.stringify(chunkCSS)};` +
            `document.head.appendChild(${style});`
          if (config.build.sourcemap) {
            const s = new MagicString(code)
            s.prepend(injectCode)
            return {
              code: s.toString(),
              map: s.generateMap({ hires: true })
            }
          } else {
            return { code: injectCode + code }
          }
        }
      } else {
        // non-split extracted CSS will be minified together
        chunkCSS = await processChunkCSS(chunkCSS, {
          inlined: false,
          minify: false
        })
        outputToExtractedCSSMap.set(
          opts,
          (outputToExtractedCSSMap.get(opts) || '') + chunkCSS
        )
      }
      return null
    },

    async generateBundle(opts, bundle) {
      // @ts-ignore asset emits are skipped in legacy bundle
      if (opts.__vite_skip_asset_emit__) {
        return
      }

      // remove empty css chunks and their imports
      if (pureCssChunks.size) {
        const emptyChunkFiles = [...pureCssChunks]
          .map((file) => path.basename(file))
          .join('|')
          .replace(/\./g, '\\.')
        const emptyChunkRE = new RegExp(
          opts.format === 'es'
            ? `\\bimport\\s*"[^"]*(?:${emptyChunkFiles})";\n?`
            : `\\brequire\\(\\s*"[^"]*(?:${emptyChunkFiles})"\\);\n?`,
          'g'
        )
        for (const file in bundle) {
          const chunk = bundle[file]
          if (chunk.type === 'chunk') {
            // remove pure css chunk from other chunk's imports,
            // and also register the emitted CSS files under the importer
            // chunks instead.
            chunk.imports = chunk.imports.filter((file) => {
              if (pureCssChunks.has(file)) {
                const {
                  viteMetadata: { importedCss }
                } = bundle[file] as OutputChunk
                importedCss.forEach((file) =>
                  chunk.viteMetadata.importedCss.add(file)
                )
                return false
              }
              return true
            })
            chunk.code = chunk.code.replace(
              emptyChunkRE,
              // remove css import while preserving source map location
              (m) => `/* empty css ${''.padEnd(m.length - 15)}*/`
            )
          }
        }
        const removedPureCssFiles = removedPureCssFilesCache.get(config)!
        pureCssChunks.forEach((fileName) => {
          removedPureCssFiles.set(fileName, bundle[fileName] as RenderedChunk)
          delete bundle[fileName]
        })
      }

      let extractedCss = outputToExtractedCSSMap.get(opts)
      if (extractedCss && !hasEmitted) {
        hasEmitted = true
        // minify css
        if (config.build.minify) {
          extractedCss = await minifyCSS(extractedCss, config)
        }
        this.emitFile({
          name: 'style.css',
          type: 'asset',
          source: extractedCss
        })
      }
    }
  }
}

interface CSSAtImportResolvers {
  css: ResolveFn
  sass: ResolveFn
  less: ResolveFn
}

function createCSSResolvers(config: ResolvedConfig): CSSAtImportResolvers {
  let cssResolve: ResolveFn | undefined
  let sassResolve: ResolveFn | undefined
  let lessResolve: ResolveFn | undefined
  return {
    get css() {
      return (
        cssResolve ||
        (cssResolve = config.createResolver({
          extensions: ['.css'],
          mainFields: ['style'],
          tryIndex: false,
          preferRelative: true
        }))
      )
    },

    get sass() {
      return (
        sassResolve ||
        (sassResolve = config.createResolver({
          extensions: ['.scss', '.sass', '.css'],
          mainFields: ['sass', 'style'],
          tryIndex: true,
          tryPrefix: '_',
          preferRelative: true
        }))
      )
    },

    get less() {
      return (
        lessResolve ||
        (lessResolve = config.createResolver({
          extensions: ['.less', '.css'],
          mainFields: ['less', 'style'],
          tryIndex: false,
          preferRelative: true
        }))
      )
    }
  }
}

function getCssResolversKeys(
  resolvers: CSSAtImportResolvers
): Array<keyof CSSAtImportResolvers> {
  return Object.keys(resolvers) as unknown as Array<keyof CSSAtImportResolvers>
}

async function compileCSS(
  id: string,
  code: string,
  config: ResolvedConfig,
  urlReplacer: CssUrlReplacer,
  atImportResolvers: CSSAtImportResolvers,
  server?: ViteDevServer
): Promise<{
  code: string
  map?: SourceMapInput
  ast?: Postcss.Result
  modules?: Record<string, string>
  deps?: Set<string>
}> {
  const { modules: modulesOptions, preprocessorOptions } = config.css || {}
  const isModule = modulesOptions !== false && cssModuleRE.test(id)
  // although at serve time it can work without processing, we do need to
  // crawl them in order to register watch dependencies.
  const needInlineImport = code.includes('@import')
  const hasUrl = cssUrlRE.test(code) || cssImageSetRE.test(code)
  const postcssConfig = await resolvePostcssConfig(config)
  const lang = id.match(cssLangRE)?.[1] as CssLang | undefined

  // 1. plain css that needs no processing
  if (
    lang === 'css' &&
    !postcssConfig &&
    !isModule &&
    !needInlineImport &&
    !hasUrl
  ) {
    return { code, map: null }
  }

  let preprocessorMap: ExistingRawSourceMap | undefined
  let modules: Record<string, string> | undefined
  const deps = new Set<string>()

  // 2. pre-processors: sass etc.
  if (isPreProcessor(lang)) {
    const preProcessor = preProcessors[lang]
    let opts = (preprocessorOptions && preprocessorOptions[lang]) || {}
    // support @import from node dependencies by default
    switch (lang) {
      case PreprocessLang.scss:
      case PreprocessLang.sass:
        opts = {
          includePaths: ['node_modules'],
          alias: config.resolve.alias,
          ...opts
        }
        break
      case PreprocessLang.less:
      case PreprocessLang.styl:
      case PreprocessLang.stylus:
        opts = {
          paths: ['node_modules'],
          alias: config.resolve.alias,
          ...opts
        }
    }
    // important: set this for relative import resolving
    opts.filename = cleanUrl(id)

    const preprocessResult = await preProcessor(
      code,
      config.root,
      opts,
      atImportResolvers
    )

    if (preprocessResult.errors.length) {
      throw preprocessResult.errors[0]
    }

    code = preprocessResult.code
    preprocessorMap = combineSourcemapsIfExists(
      opts.filename,
      preprocessResult.map,
      preprocessResult.additionalMap
    )

    if (preprocessResult.deps) {
      preprocessResult.deps.forEach((dep) => {
        // sometimes sass registers the file itself as a dep
        if (normalizePath(dep) !== normalizePath(opts.filename)) {
          deps.add(dep)
        }
      })
    }
  }

  // 3. postcss
  const postcssOptions = (postcssConfig && postcssConfig.options) || {}
  const postcssPlugins =
    postcssConfig && postcssConfig.plugins ? postcssConfig.plugins.slice() : []

  if (needInlineImport) {
    const isHTMLProxy = htmlProxyRE.test(id)
    postcssPlugins.unshift(
      (await import('postcss-import')).default({
        async resolve(id, basedir) {
          const publicFile = checkPublicFile(id, config)
          if (isHTMLProxy && publicFile) {
            return publicFile
          }

          const resolved = await atImportResolvers.css(
            id,
            path.join(basedir, '*')
          )

          if (resolved) {
            return path.resolve(resolved)
          }
          return id
        }
      })
    )
  }
  postcssPlugins.push(
    UrlRewritePostcssPlugin({
      replacer: urlReplacer
    }) as Postcss.Plugin
  )

  if (isModule) {
    postcssPlugins.unshift(
      (await import('postcss-modules')).default({
        ...modulesOptions,
        getJSON(
          cssFileName: string,
          _modules: Record<string, string>,
          outputFileName: string
        ) {
          modules = _modules
          if (modulesOptions && typeof modulesOptions.getJSON === 'function') {
            modulesOptions.getJSON(cssFileName, _modules, outputFileName)
          }
        },
        async resolve(id: string) {
          for (const key of getCssResolversKeys(atImportResolvers)) {
            const resolved = await atImportResolvers[key](id)
            if (resolved) {
              return path.resolve(resolved)
            }
          }

          return id
        }
      })
    )
  }

  if (!postcssPlugins.length) {
    return {
      code,
      map: preprocessorMap
    }
  }

  // postcss is an unbundled dep and should be lazy imported
  const postcssResult = await (await import('postcss'))
    .default(postcssPlugins)
    .process(code, {
      ...postcssOptions,
      to: cleanUrl(id),
      from: cleanUrl(id),
      map: {
        inline: false,
        annotation: false,
        sourcesContent: false
        // when "prev: preprocessorMap", the result map may include duplicate filename in `postcssResult.map.sources`
        // prev: preprocessorMap,
      }
    })

  // record CSS dependencies from @imports
  for (const message of postcssResult.messages) {
    if (message.type === 'dependency') {
      deps.add(normalizePath(message.file as string))
    } else if (message.type === 'dir-dependency') {
      // https://github.com/postcss/postcss/blob/main/docs/guidelines/plugin.md#3-dependencies
      const { dir, glob: globPattern = '**' } = message
      const pattern =
        normalizePath(path.resolve(path.dirname(id), dir)) + `/` + globPattern
      const files = glob.sync(pattern, {
        ignore: ['**/node_modules/**']
      })
      for (let i = 0; i < files.length; i++) {
        deps.add(files[i])
      }
      if (server) {
        // register glob importers so we can trigger updates on file add/remove
        if (!(id in server._globImporters)) {
          server._globImporters[id] = {
            module: server.moduleGraph.getModuleById(id)!,
            importGlobs: []
          }
        }
        server._globImporters[id].importGlobs.push({
          base: config.root,
          pattern
        })
      }
    } else if (message.type === 'warning') {
      let msg = `[vite:css] ${message.text}`
      if (message.line && message.column) {
        msg += `\n${generateCodeFrame(code, {
          line: message.line,
          column: message.column
        })}`
      }
      config.logger.warn(colors.yellow(msg))
    }
  }

  const rawPostcssMap = postcssResult.map.toJSON()

  const postcssMap = formatPostcssSourceMap(
    // version property of rawPostcssMap is declared as string
    // but actually it is a number
    rawPostcssMap as Omit<RawSourceMap, 'version'> as ExistingRawSourceMap,
    cleanUrl(id)
  )

  return {
    ast: postcssResult,
    code: postcssResult.css,
    map: combineSourcemapsIfExists(cleanUrl(id), postcssMap, preprocessorMap),
    modules,
    deps
  }
}

export function formatPostcssSourceMap(
  rawMap: ExistingRawSourceMap,
  file: string
): ExistingRawSourceMap {
  const inputFileDir = path.dirname(file)
  const sources = rawMap.sources
    // remove <no source> from sources, to prevent source map to be combined incorrectly
    .filter((source) => source !== '<no source>')
    .map((source) => {
      const cleanSource = cleanUrl(decodeURIComponent(source))
      return normalizePath(path.resolve(inputFileDir, cleanSource))
    })

  return {
    file,
    mappings: rawMap.mappings,
    names: rawMap.names,
    sources,
    version: rawMap.version
  }
}

function combineSourcemapsIfExists(
  filename: string,
  map1: ExistingRawSourceMap | undefined,
  map2: ExistingRawSourceMap | undefined
): ExistingRawSourceMap | undefined {
  return map1 && map2
    ? (combineSourcemaps(filename, [
        // type of version property of ExistingRawSourceMap is number
        // but it is always 3
        map1 as RawSourceMap,
        map2 as RawSourceMap
      ]) as ExistingRawSourceMap)
    : map1
}

interface PostCSSConfigResult {
  options: Postcss.ProcessOptions
  plugins: Postcss.Plugin[]
}

async function resolvePostcssConfig(
  config: ResolvedConfig
): Promise<PostCSSConfigResult | null> {
  let result = postcssConfigCache.get(config)
  if (result !== undefined) {
    return result
  }

  // inline postcss config via vite config
  const inlineOptions = config.css?.postcss
  if (isObject(inlineOptions)) {
    const options = { ...inlineOptions }

    delete options.plugins
    result = {
      options,
      plugins: inlineOptions.plugins || []
    }
  } else {
    try {
      const searchPath =
        typeof inlineOptions === 'string' ? inlineOptions : config.root
      // @ts-ignore
      result = await postcssrc({}, searchPath)
    } catch (e) {
      if (!/No PostCSS Config found/.test(e.message)) {
        throw e
      }
      result = null
    }
  }

  postcssConfigCache.set(config, result)
  return result
}

type CssUrlReplacer = (
  url: string,
  importer?: string
) => string | Promise<string>
// https://drafts.csswg.org/css-syntax-3/#identifier-code-point
export const cssUrlRE =
  /(?<=^|[^\w\-\u0080-\uffff])url\(\s*('[^']+'|"[^"]+"|[^'")]+)\s*\)/
export const importCssRE = /@import ('[^']+\.css'|"[^"]+\.css"|[^'")]+\.css)/
const cssImageSetRE = /image-set\(([^)]+)\)/

const UrlRewritePostcssPlugin: Postcss.PluginCreator<{
  replacer: CssUrlReplacer
}> = (opts) => {
  if (!opts) {
    throw new Error('base or replace is required')
  }

  return {
    postcssPlugin: 'vite-url-rewrite',
    Once(root) {
      const promises: Promise<void>[] = []
      root.walkDecls((declaration) => {
        const isCssUrl = cssUrlRE.test(declaration.value)
        const isCssImageSet = cssImageSetRE.test(declaration.value)
        if (isCssUrl || isCssImageSet) {
          const replacerForDeclaration = (rawUrl: string) => {
            const importer = declaration.source?.input.file
            return opts.replacer(rawUrl, importer)
          }
          const rewriterToUse = isCssUrl ? rewriteCssUrls : rewriteCssImageSet
          promises.push(
            rewriterToUse(declaration.value, replacerForDeclaration).then(
              (url) => {
                declaration.value = url
              }
            )
          )
        }
      })
      if (promises.length) {
        return Promise.all(promises) as any
      }
    }
  }
}
UrlRewritePostcssPlugin.postcss = true

function rewriteCssUrls(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, cssUrlRE, async (match) => {
    const [matched, rawUrl] = match
    return await doUrlReplace(rawUrl, matched, replacer)
  })
}

function rewriteImportCss(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, importCssRE, async (match) => {
    const [matched, rawUrl] = match
    return await doImportCSSReplace(rawUrl, matched, replacer)
  })
}

function rewriteCssImageSet(
  css: string,
  replacer: CssUrlReplacer
): Promise<string> {
  return asyncReplace(css, cssImageSetRE, async (match) => {
    const [matched, rawUrl] = match
    const url = await processSrcSet(rawUrl, ({ url }) =>
      doUrlReplace(url, matched, replacer)
    )
    return `image-set(${url})`
  })
}
async function doUrlReplace(
  rawUrl: string,
  matched: string,
  replacer: CssUrlReplacer
) {
  let wrap = ''
  const first = rawUrl[0]
  if (first === `"` || first === `'`) {
    wrap = first
    rawUrl = rawUrl.slice(1, -1)
  }
  if (isExternalUrl(rawUrl) || isDataUrl(rawUrl) || rawUrl.startsWith('#')) {
    return matched
  }

  return `url(${wrap}${await replacer(rawUrl)}${wrap})`
}

async function doImportCSSReplace(
  rawUrl: string,
  matched: string,
  replacer: CssUrlReplacer
) {
  let wrap = ''
  const first = rawUrl[0]
  if (first === `"` || first === `'`) {
    wrap = first
    rawUrl = rawUrl.slice(1, -1)
  }
  if (isExternalUrl(rawUrl) || isDataUrl(rawUrl) || rawUrl.startsWith('#')) {
    return matched
  }

  return `@import ${wrap}${await replacer(rawUrl)}${wrap}`
}

async function minifyCSS(css: string, config: ResolvedConfig) {
  const { code, warnings } = await transform(css, {
    loader: 'css',
    minify: true,
    target: config.build.cssTarget || undefined
  })
  if (warnings.length) {
    const msgs = await formatMessages(warnings, { kind: 'warning' })
    config.logger.warn(
      colors.yellow(`warnings when minifying css:\n${msgs.join('\n')}`)
    )
  }
  return code
}

// #1845
// CSS @import can only appear at top of the file. We need to hoist all @import
// to top when multiple files are concatenated.
async function hoistAtImports(css: string) {
  const postcss = await import('postcss')
  return (await postcss.default([AtImportHoistPlugin]).process(css)).css
}

const AtImportHoistPlugin: Postcss.PluginCreator<any> = () => {
  return {
    postcssPlugin: 'vite-hoist-at-imports',
    Once(root) {
      const imports: Postcss.AtRule[] = []
      root.walkAtRules((rule) => {
        if (rule.name === 'import') {
          // record in reverse so that can simply prepend to preserve order
          imports.unshift(rule)
        }
      })
      imports.forEach((i) => root.prepend(i))
    }
  }
}
AtImportHoistPlugin.postcss = true

// Preprocessor support. This logic is largely replicated from @vue/compiler-sfc

type PreprocessorAdditionalDataResult =
  | string
  | { content: string; map?: ExistingRawSourceMap }

type PreprocessorAdditionalData =
  | string
  | ((
      source: string,
      filename: string
    ) =>
      | PreprocessorAdditionalDataResult
      | Promise<PreprocessorAdditionalDataResult>)

type StylePreprocessorOptions = {
  [key: string]: any
  additionalData?: PreprocessorAdditionalData
  filename: string
  alias: Alias[]
}

type SassStylePreprocessorOptions = StylePreprocessorOptions & Sass.Options

type StylePreprocessor = (
  source: string,
  root: string,
  options: StylePreprocessorOptions,
  resolvers: CSSAtImportResolvers
) => StylePreprocessorResults | Promise<StylePreprocessorResults>

type SassStylePreprocessor = (
  source: string,
  root: string,
  options: SassStylePreprocessorOptions,
  resolvers: CSSAtImportResolvers
) => StylePreprocessorResults | Promise<StylePreprocessorResults>

export interface StylePreprocessorResults {
  code: string
  map?: ExistingRawSourceMap | undefined
  additionalMap?: ExistingRawSourceMap | undefined
  errors: RollupError[]
  deps: string[]
}

const loadedPreprocessors: Partial<Record<PreprocessLang, any>> = {}

function loadPreprocessor(lang: PreprocessLang.scss, root: string): typeof Sass
function loadPreprocessor(lang: PreprocessLang.sass, root: string): typeof Sass
function loadPreprocessor(lang: PreprocessLang.less, root: string): typeof Less
function loadPreprocessor(
  lang: PreprocessLang.stylus,
  root: string
): typeof Stylus
function loadPreprocessor(lang: PreprocessLang, root: string): any {
  if (lang in loadedPreprocessors) {
    return loadedPreprocessors[lang]
  }
  try {
    // Search for the preprocessor in the root directory first, and fall back
    // to the default require paths.
    const fallbackPaths = require.resolve.paths?.(lang) || []
    const resolved = require.resolve(lang, { paths: [root, ...fallbackPaths] })
    return (loadedPreprocessors[lang] = require(resolved))
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `Preprocessor dependency "${lang}" not found. Did you install it?`
      )
    } else {
      const message = new Error(
        `Preprocessor dependency "${lang}" failed to load:\n${e.message}`
      )
      message.stack = e.stack + '\n' + message.stack
      throw message
    }
  }
}

// .scss/.sass processor
const scss: SassStylePreprocessor = async (
  source,
  root,
  options,
  resolvers
) => {
  const render = loadPreprocessor(PreprocessLang.sass, root).render
  const internalImporter: Sass.Importer = (url, importer, done) => {
    resolvers.sass(url, importer).then((resolved) => {
      if (resolved) {
        rebaseUrls(resolved, options.filename, options.alias)
          .then((data) => done?.(data))
          .catch((data) => done?.(data))
      } else {
        done?.(null)
      }
    })
  }
  const importer = [internalImporter]
  if (options.importer) {
    Array.isArray(options.importer)
      ? importer.push(...options.importer)
      : importer.push(options.importer)
  }

  const { content: data, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData
  )
  const finalOptions: Sass.Options = {
    ...options,
    data,
    file: options.filename,
    outFile: options.filename,
    importer,
    sourceMap: true,
    omitSourceMapUrl: true,
    sourceMapRoot: path.dirname(options.filename)
  }

  try {
    const result = await new Promise<Sass.Result>((resolve, reject) => {
      render(finalOptions, (err, res) => {
        if (err) {
          reject(err)
        } else {
          resolve(res)
        }
      })
    })
    const deps = result.stats.includedFiles
    const map: ExistingRawSourceMap | undefined = result.map
      ? JSON.parse(result.map.toString())
      : undefined

    return {
      code: result.css.toString(),
      map,
      additionalMap,
      errors: [],
      deps
    }
  } catch (e) {
    // normalize SASS error
    e.id = e.file
    e.frame = e.formatted
    return { code: '', errors: [e], deps: [] }
  }
}

const sass: SassStylePreprocessor = (source, root, options, aliasResolver) =>
  scss(
    source,
    root,
    {
      ...options,
      indentedSyntax: true
    },
    aliasResolver
  )

/**
 * relative url() inside \@imported sass and less files must be rebased to use
 * root file as base.
 */
async function rebaseUrls(
  file: string,
  rootFile: string,
  alias: Alias[]
): Promise<Sass.ImporterReturnType> {
  file = path.resolve(file) // ensure os-specific flashes
  // in the same dir, no need to rebase
  const fileDir = path.dirname(file)
  const rootDir = path.dirname(rootFile)
  if (fileDir === rootDir) {
    return { file }
  }

  const content = fs.readFileSync(file, 'utf-8')
  // no url()
  const hasUrls = cssUrlRE.test(content)
  // no @import xxx.css
  const hasImportCss = importCssRE.test(content)

  if (!hasUrls && !hasImportCss) {
    return { file }
  }

  let rebased
  const rebaseFn = (url: string) => {
    if (url.startsWith('/')) return url
    // match alias, no need to rewrite
    for (const { find } of alias) {
      const matches =
        typeof find === 'string' ? url.startsWith(find) : find.test(url)
      if (matches) {
        return url
      }
    }
    const absolute = path.resolve(fileDir, url)
    const relative = path.relative(rootDir, absolute)
    return normalizePath(relative)
  }

  // fix css imports in less such as `@import "foo.css"`
  if (hasImportCss) {
    rebased = await rewriteImportCss(content, rebaseFn)
  }

  if (hasUrls) {
    rebased = await rewriteCssUrls(rebased || content, rebaseFn)
  }

  return {
    file,
    contents: rebased
  }
}

// .less
const less: StylePreprocessor = async (source, root, options, resolvers) => {
  const nodeLess = loadPreprocessor(PreprocessLang.less, root)
  const viteResolverPlugin = createViteLessPlugin(
    nodeLess,
    options.filename,
    options.alias,
    resolvers
  )
  const { content, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData
  )

  let result: Less.RenderOutput | undefined
  try {
    result = await nodeLess.render(content, {
      ...options,
      plugins: [viteResolverPlugin, ...(options.plugins || [])],
      sourceMap: {
        outputSourceFiles: true,
        sourceMapFileInline: false
      }
    })
  } catch (e) {
    const error = e as Less.RenderError
    // normalize error info
    const normalizedError: RollupError = new Error(error.message || error.type)
    normalizedError.loc = {
      file: error.filename || options.filename,
      line: error.line,
      column: error.column
    }
    return { code: '', errors: [normalizedError], deps: [] }
  }

  const map: ExistingRawSourceMap = JSON.parse(result.map)
  delete map.sourcesContent

  return {
    code: result.css.toString(),
    map,
    additionalMap,
    deps: result.imports,
    errors: []
  }
}

/**
 * Less manager, lazy initialized
 */
let ViteLessManager: any

function createViteLessPlugin(
  less: typeof Less,
  rootFile: string,
  alias: Alias[],
  resolvers: CSSAtImportResolvers
): Less.Plugin {
  if (!ViteLessManager) {
    ViteLessManager = class ViteManager extends less.FileManager {
      resolvers
      rootFile
      alias
      constructor(
        rootFile: string,
        resolvers: CSSAtImportResolvers,
        alias: Alias[]
      ) {
        super()
        this.rootFile = rootFile
        this.resolvers = resolvers
        this.alias = alias
      }
      override supports() {
        return true
      }
      override supportsSync() {
        return false
      }
      override async loadFile(
        filename: string,
        dir: string,
        opts: any,
        env: any
      ): Promise<Less.FileLoadResult> {
        const resolved = await this.resolvers.less(
          filename,
          path.join(dir, '*')
        )
        if (resolved) {
          const result = await rebaseUrls(resolved, this.rootFile, this.alias)
          let contents: string
          if (result && 'contents' in result) {
            contents = result.contents
          } else {
            contents = fs.readFileSync(resolved, 'utf-8')
          }
          return {
            filename: path.resolve(resolved),
            contents
          }
        } else {
          return super.loadFile(filename, dir, opts, env)
        }
      }
    }
  }

  return {
    install(_, pluginManager) {
      pluginManager.addFileManager(
        new ViteLessManager(rootFile, resolvers, alias)
      )
    },
    minVersion: [3, 0, 0]
  }
}

// .styl
const styl: StylePreprocessor = async (source, root, options) => {
  const nodeStylus = loadPreprocessor(PreprocessLang.stylus, root)
  // Get source with preprocessor options.additionalData. Make sure a new line separator
  // is added to avoid any render error, as added stylus content may not have semi-colon separators
  const { content, map: additionalMap } = await getSource(
    source,
    options.filename,
    options.additionalData,
    '\n'
  )
  // Get preprocessor options.imports dependencies as stylus
  // does not return them with its builtin `.deps()` method
  const importsDeps = (options.imports ?? []).map((dep: string) =>
    path.resolve(dep)
  )
  try {
    const ref = nodeStylus(content, options)
    ref.set('sourcemap', {
      comment: false,
      inline: false,
      basePath: root
    })

    const result = ref.render()

    // Concat imports deps with computed deps
    const deps = [...ref.deps(), ...importsDeps]

    // @ts-expect-error sourcemap exists
    const map: ExistingRawSourceMap = ref.sourcemap

    return {
      code: result,
      map: formatStylusSourceMap(map, root),
      additionalMap,
      errors: [],
      deps
    }
  } catch (e) {
    return { code: '', errors: [e], deps: [] }
  }
}

function formatStylusSourceMap(
  mapBefore: ExistingRawSourceMap,
  root: string
): ExistingRawSourceMap {
  const map = { ...mapBefore }

  const resolveFromRoot = (p: string) => normalizePath(path.resolve(root, p))

  if (map.file) {
    map.file = resolveFromRoot(map.file)
  }
  map.sources = map.sources.map(resolveFromRoot)

  return map
}

async function getSource(
  source: string,
  filename: string,
  additionalData?: PreprocessorAdditionalData,
  sep: string = ''
): Promise<{ content: string; map?: ExistingRawSourceMap }> {
  if (!additionalData) return { content: source }

  if (typeof additionalData === 'function') {
    const newContent = await additionalData(source, filename)
    if (typeof newContent === 'string') {
      return { content: newContent }
    }
    return newContent
  }

  const ms = new MagicString(source)
  ms.appendLeft(0, sep)
  ms.appendLeft(0, additionalData)

  const map = ms.generateMap({ hires: true })
  map.file = filename
  map.sources = [filename]

  return {
    content: ms.toString(),
    map
  }
}

const preProcessors = Object.freeze({
  [PreprocessLang.less]: less,
  [PreprocessLang.sass]: sass,
  [PreprocessLang.scss]: scss,
  [PreprocessLang.styl]: styl,
  [PreprocessLang.stylus]: styl
})

function isPreProcessor(lang: any): lang is PreprocessLang {
  return lang && lang in preProcessors
}
