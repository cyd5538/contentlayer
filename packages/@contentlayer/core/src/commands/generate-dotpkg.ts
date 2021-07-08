import {
  flow,
  inflection,
  lowercaseFirstChar,
  omit,
  pattern,
  traceAsyncFn,
  uppercaseFirstChar,
} from '@contentlayer/utils'
import { camelCase } from 'camel-case'
import { promises as fs } from 'fs'
import * as path from 'path'
import type { Observable } from 'rxjs'
import { of } from 'rxjs'
import { combineLatest, defer } from 'rxjs'
import { switchMap } from 'rxjs/operators'
import type { PackageJson } from 'type-fest'

import type { Cache } from '../cache'
import type { SourcePlugin, SourcePluginType } from '../plugin'
import type { DocumentDef, SchemaDef } from '../schema'
import { makeArtifactsDir } from '../utils'
import { renderDocumentOrObjectDef } from './generate-types'

/**
 * Used to track which files already have been written.
 * Gets re-initialized per `generateDotpkg` invocation therefore only "works" during dev mode.
 */
type FilePath = string
type DocumentHash = string
type WrittenFilesCache = Record<FilePath, DocumentHash>

// TODO make sure unused old generated files are removed
export const generateDotpkg = ({ source, watchData }: { source: SourcePlugin; watchData: boolean }): Observable<void> =>
  combineLatest({
    cache: source.fetchData({ watch: watchData }),
    schemaDef: defer(async () => source.provideSchema()),
    targetPath: defer(makeArtifactsDir),
    sourcePluginType: of(source.type),
    writtenFilesCache: of({}),
  }).pipe(switchMap(writeFilesForCache))

const writeFilesForCache = (async ({
  cache,
  schemaDef,
  targetPath,
  sourcePluginType,
  writtenFilesCache,
}: {
  schemaDef: SchemaDef
  cache: Cache
  targetPath: string
  sourcePluginType: SourcePluginType
  writtenFilesCache: WrittenFilesCache
}): Promise<void> => {
  const withPrefix = (...path_: string[]) => path.join(targetPath, ...path_)

  const allCacheItems = Object.values(cache.cacheItemsMap)
  const allDocuments = allCacheItems.map((_) => _.document)

  const documentDefs = Object.values(schemaDef.documentDefMap)

  const dataBarrelFiles = documentDefs.map((docDef) => ({
    content: makeDataExportFile({
      docDef,
      documentIds: allDocuments.filter((_) => _._typeName === docDef.name).map((_) => _._id),
    }),
    filePath: withPrefix('data', `${getDataVariableName({ docDef })}.js`),
  }))

  const dataJsonFiles = allCacheItems.map(({ document, documentHash }) => ({
    content: JSON.stringify(document, null, 2),
    filePath: withPrefix('data', document._typeName, `${idToFileName(document._id)}.json`),
    documentHash,
  }))

  const dataDirPaths = documentDefs.map((_) => withPrefix('data', _.name))
  await Promise.all([mkdir(withPrefix('types')), ...dataDirPaths.map(mkdir)])

  const writeFile = writeFileWithWrittenFilesCache({ writtenFilesCache })

  await Promise.all([
    writeFile({ filePath: withPrefix('package.json'), content: makePackageJson() }),
    writeFile({
      filePath: withPrefix('types', 'index.d.ts'),
      content: makeTypes({ schemaDef, sourcePluginType }),
    }),
    writeFile({ filePath: withPrefix('types', 'index.js'), content: makeHelperTypes() }),
    writeFile({ filePath: withPrefix('data', 'index.d.ts'), content: makeDataTypes({ schemaDef }) }),
    writeFile({ filePath: withPrefix('data', 'index.js'), content: makeIndexJs({ schemaDef }) }),
    ...dataBarrelFiles.map(writeFile),
    ...dataJsonFiles.map(writeFile),
  ])
})['|>'](traceAsyncFn('@contentlayer/core/commands/generate-dotpkg:writeFilesForCache', (_) => omit(_, ['cache'])))

const makePackageJson = (): string => {
  const packageJson: PackageJson & { typesVersions: any } = {
    name: 'dot-contentlayer',
    description: 'This package is auto-generated by Contentlayer',
    version: '0.0.0',
    exports: {
      './data': {
        import: './data/index.js',
      },
      './types': {
        import: './types/index.js',
      },
    },
    typesVersions: {
      '*': {
        data: ['./data'],
        types: ['./types'],
      },
    },
  }

  return JSON.stringify(packageJson, null, 2)
}

const mkdir = async (dirPath: string) => {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (e) {
    if (e.code !== 'EEXIST') {
      throw e
    }
  }
}

/**
 * Remembers which files already have been written to disk.
 * If no `documentHash` was provided, the writes won't be cached. */
const writeFileWithWrittenFilesCache =
  ({ writtenFilesCache }: { writtenFilesCache: WrittenFilesCache }) =>
  async ({
    filePath,
    content,
    documentHash,
  }: {
    filePath: string
    content: string
    documentHash?: string
  }): Promise<void> => {
    if (documentHash !== undefined && writtenFilesCache[filePath] === documentHash) {
      return
    }

    await fs.writeFile(filePath, content, 'utf8')
    if (documentHash) {
      writtenFilesCache[filePath] = documentHash
    }
  }

const makeDataExportFile = ({ docDef, documentIds }: { docDef: DocumentDef; documentIds: string[] }): string => {
  const dataVariableName = getDataVariableName({ docDef })

  if (docDef.isSingleton) {
    const documentId = documentIds[0]
    return `\
// ${autogeneratedNote}
export { default as ${dataVariableName} } from './${docDef.name}/${idToFileName(documentId)}.json'
`
  }

  const makeVariableName = flow(idToFileName, (_) => camelCase(_, { stripRegexp: /[^A-Z0-9\_]/gi }))

  const docImports = documentIds
    .map((_) => `import ${makeVariableName(_)} from './${docDef.name}/${idToFileName(_)}.json'`)
    .join('\n')

  return `\
// ${autogeneratedNote}

${docImports}

export const ${dataVariableName} = [${documentIds.map((_) => makeVariableName(_)).join(', ')}]
`
}

const makeIndexJs = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const dataVariableNames = Object.values(schemaDef.documentDefMap).map(
    (docDef) => [docDef, getDataVariableName({ docDef })] as const,
  )
  const constReexports = dataVariableNames
    .map(([, dataVariableName]) => `export * from './${dataVariableName}.js'`)
    .join('\n')

  const constImportsForAllDocuments = dataVariableNames
    .map(([, dataVariableName]) => `import { ${dataVariableName} } from './${dataVariableName}.js'`)
    .join('\n')

  const allDocuments = dataVariableNames
    .map(([docDef, dataVariableName]) => (docDef.isSingleton ? dataVariableName : `...${dataVariableName}`))
    .join(', ')

  return `\
// ${autogeneratedNote}

export { isType } from 'contentlayer/client'

${constReexports}
${constImportsForAllDocuments}

export const allDocuments = [${allDocuments}]
`
}

const autogeneratedNote = `NOTE This file is auto-generated by the Contentlayer CLI`

const makeTypes = ({
  schemaDef,
  sourcePluginType,
}: {
  schemaDef: SchemaDef
  sourcePluginType: SourcePluginType
}): string => {
  const documentTypes = Object.values(schemaDef.documentDefMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => ({
      typeName: def.name,
      typeDef: renderDocumentOrObjectDef({ def, sourcePluginType }),
    }))

  const objectTypes = Object.values(schemaDef.objectDefMap)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((def) => ({
      typeName: def.name,
      typeDef: renderDocumentOrObjectDef({ def, sourcePluginType }),
    }))

  // TODO this might be no longer needed and can be removed once `isType` has been refactored
  // to not depend on global types
  const typeMap = documentTypes
    .map((_) => _.typeName)
    .map((_) => `  ${_}: ${_}`)
    .join('\n')

  const importsForRawTypes = pattern
    .match(sourcePluginType)
    .with('local', () => `import * as Local from 'contentlayer/source-local'`)
    .with('contentful', () => `import * as Contentful from '@contentlayer/source-contentful'`)
    .otherwise(() => ``)

  return `\
// ${autogeneratedNote}

import type { Markdown, MDX } from 'contentlayer/core'
${importsForRawTypes}

export { isType } from 'contentlayer/client'

export type Image = string
export type { Markdown, MDX }

export interface ContentlayerGenTypes {
  documentTypes: DocumentTypes
  documentTypeMap: DocumentTypeMap
  documentTypeNames: DocumentTypeNames
  allTypeNames: AllTypeNames
}

declare global {
  interface ContentlayerGen extends ContentlayerGenTypes {}
}

export type DocumentTypeMap = {
${typeMap}
}

export type AllTypes = DocumentTypes | ObjectTypes
export type AllTypeNames = DocumentTypeNames | ObjectTypeNames

export type DocumentTypes = ${documentTypes.map((_) => _.typeName).join(' | ')}
export type DocumentTypeNames = DocumentTypes['_typeName']

export type ObjectTypes = ${objectTypes.length > 0 ? objectTypes.map((_) => _.typeName).join(' | ') : 'never'}
export type ObjectTypeNames = ObjectTypes['_typeName']



/** Document types */
${documentTypes.map((_) => _.typeDef).join('\n\n')}  

/** Object types */
${objectTypes.map((_) => _.typeDef).join('\n\n')}  
  
 `
}

const makeHelperTypes = (): string => {
  return `\
// ${autogeneratedNote}

export { isType } from 'contentlayer/client'
`
}

const makeDataTypes = ({ schemaDef }: { schemaDef: SchemaDef }): string => {
  const dataConsts = Object.values(schemaDef.documentDefMap)
    .map((docDef) => [docDef, docDef.name, getDataVariableName({ docDef })] as const)
    .map(
      ([docDef, typeName, dataVariableName]) =>
        `export declare const ${dataVariableName}: ${typeName}${docDef.isSingleton ? '' : '[]'}`,
    )
    .join('\n')

  const documentTypeNames = Object.values(schemaDef.documentDefMap)
    .map((docDef) => docDef.name)
    .join(', ')

  return `\
// ${autogeneratedNote}

import { ${documentTypeNames}, DocumentTypes } from '../types'

${dataConsts}

export declare const allDocuments: DocumentTypes[]

`
}

const getDataVariableName = ({ docDef }: { docDef: DocumentDef }): string => {
  if (docDef.isSingleton) {
    return lowercaseFirstChar(inflection.singularize(docDef.name))
  } else {
    return 'all' + uppercaseFirstChar(inflection.pluralize(docDef.name))
  }
}

const idToFileName = (id: string): string => {
  return leftPadWithUnderscoreIfStartsWithNumber(id).replace(/\//g, '__')
}

const leftPadWithUnderscoreIfStartsWithNumber = (str: string): string => {
  if (/^[0-9]/.test(str)) {
    return '_' + str
  }
  return str
}
