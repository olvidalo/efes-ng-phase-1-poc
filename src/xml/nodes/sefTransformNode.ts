import {
    type FileRef,
    type Input,
    inputIsNodeOutputReference,
    type PipelineContext,
    PipelineNode,
    type PipelineNodeConfig
} from "../../core/pipeline";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

// @ts-ignore
// Register Kiln extension functions at module load
// @ts-ignore
import SaxonJS, {transform} from 'saxonjs-he';

// Register the kiln:url-for-match function implementation
SaxonJS.registerExtensionFunctions({
    "namespace": "http://www.kcl.ac.uk/artshums/depts/ddh/kiln/ns/1.0",
    "signatures": {
        "url-for-match": {
            "as": "xs:string",
            "param": ["xs:string", "xs:string*", "xs:integer"],
            "arity": [3],
            "impl":  function(matchId: string, params: any, priority: number): string {
                // Simple implementation: generate static URLs based on parameters
                // matchId is like 'local-epidoc-display-html'
                // params is an iterator of [language, filename]
                const paramArray = Array.from(params);
                console.log(paramArray)
                console.log(`url-for-match(${matchId}, ${paramArray}, ${priority})`);
                const language = paramArray[0] || 'en';
                const filename = paramArray[1] || 'unknown';

                const routePatterns: Record<string, string> = {
                    'local-epidoc-display-html': `/${language}/inscriptions/${filename}.html`,
                    'local-epidoc-index-display': `/${language}/inscriptions/`,
                    'local-tei-display-html': `/${language}/texts/${filename}.html`,
                    'local-home-page': `/${language}/`,
                    'local-concordance-bibliography': `/${language}/concordances/bibliography/`,
                    'local-concordance-bibliography-item': `/${language}/concordances/bibliography/${filename}.html`,
                    'local-index-display-html': `/${language}/indices/${paramArray[1]}/${paramArray[2]}.html`,
                };

                return routePatterns[matchId] || `/${language}/${filename}.html`;
            }
        }
    }
});


interface SefTransformConfig extends PipelineNodeConfig {
    items?: Input;  // sourceXml files (optional for no-source transforms)
    config: {
        sefStylesheet: FileRef | Input;  // Can be FileRef or NodeOutputReference
        initialTemplate?: string;
        stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
        // TODO: passing {indent: false} indents anyway
        serializationParams?: Record<string, any>;
        initialMode?: string;
    };
    outputConfig?: {
        outputDir?: string;
        outputFilenameMapping?: (inputPath: string) => string;
        resultDocumentsDir?: string;
        resultExtension?: string;
    };
}


export class SefTransformNode extends PipelineNode<SefTransformConfig, "transformed" | "result-documents"> {

    // Helper: Calculate transformed output path (DRY - reused in getOutputPath and performWork)
    private getTransformedPath(item: string, context: PipelineContext): string {
        // If explicit outputDir specified, all paths are relative to it
        if (this.config.outputConfig?.outputDir) {
            const outputDir = this.config.outputConfig.outputDir;

            // Custom mapping returns path relative to outputDir
            if (this.config.outputConfig.outputFilenameMapping) {
                const relativePath = this.config.outputConfig.outputFilenameMapping(item);
                return path.join(outputDir, relativePath);
            }

            // Default: preserve relative path structure from source (strip build prefix)
            const extension = this.config.outputConfig?.resultExtension ?? '.xml';
            const basename = path.basename(item, path.extname(item));
            const relativePath = this.getCleanRelativePath(item, context);
            return path.join(outputDir, relativePath, basename + extension);
        }

        // No outputDir: use default build directory logic via getBuildPath
        if (this.config.outputConfig?.outputFilenameMapping) {
            const strippedItem = context.stripBuildPrefix(item);
            const relativePath = this.config.outputConfig.outputFilenameMapping(strippedItem);
            return path.join(context.buildDir, this.name, relativePath);
        }

        const extension = this.config.outputConfig?.resultExtension ?? '.xml';
        return context.getBuildPath(this.name, item, extension);
    }

    async run(context: PipelineContext) {
        // Handle both FileRef and Input (NodeOutputReference) for sefStylesheet
        const sefStylesheetPath = (this.config.config.sefStylesheet as any).path
            ? (this.config.config.sefStylesheet as FileRef).path
            : (await context.resolveInput(this.config.config.sefStylesheet as Input))[0];

        // Handle no-source mode (stylesheet uses document() for input)
        const sourcePaths = this.items ?
            await context.resolveInput(this.items) :
            [sefStylesheetPath];

        const isNoSourceMode = !this.items;
        context.log(`${isNoSourceMode ? 'Running stylesheet' : `Transforming ${sourcePaths.length} file(s)`} with ${sefStylesheetPath}`);

        const outputFilenameMapper = this.config.outputConfig?.outputFilenameMapping ?
            ((inputPath: string) => this.config.outputConfig!.outputFilenameMapping!(context.stripBuildPrefix(inputPath))) :
            ((inputPath: string) => context.getBuildPath(this.name, inputPath, this.config.outputConfig?.resultExtension ??'.html'));

        const platform = SaxonJS.internals.getPlatform();

        // TODO: does not work because of the shared platform object, we cannot
        //       know from which node we are running. We could replace the old functions
        //       back, but that would be unsafe when running in parallel
        //       (we would be replacing the functions of another node)
        //       Maybe use Worker threads for each node?
        //       The aim of this code is tracking read files that are not input files for
        //       dependency discovery, (e.g. files read by document() calls in the stylesheet)

        // const that = this;
        // let currentSourcePath;
        // const absoluteStylesheetPath = path.resolve(sefStylesheetPath);
        // const absoluteSourceFilePaths = sourcePaths.map(p => path.resolve(p));
        //
        // const replaceReadFile = (funcName: "readFile" | "readFileSync") => {
        //     const oldFunc = platform[funcName];
        //     platform[funcName] = function() {
        //         const colonIndex= arguments[0].indexOf(':');
        //         const absoluteReadFilePath = path.resolve(arguments[0].substring(colonIndex + 1));
        //
        //         // console.log({absoluteReadFilePath, absoluteStylesheetPath, absoluteSourceFilePaths})
        //         if (![absoluteStylesheetPath, ...absoluteSourceFilePaths].includes(absoluteReadFilePath)) {
        //             console.log({
        //                 node: that.config.name, absoluteReadFilePath
        //             });
        //         }
        //         return oldFunc.apply(platform, arguments);
        //     }
        // }
        //
        // replaceReadFile('readFile');
        // replaceReadFile('readFileSync');

        const results = await this.withCache<"transformed" | "result-documents">(
            context,
            sourcePaths,
            (item) => isNoSourceMode ? `no-source-${sefStylesheetPath}` : `${item}-with-${sefStylesheetPath}`,
            () => {
                // Output base directory
                return this.config.outputConfig?.outputDir ??
                       path.join(context.buildDir, this.name);
            },
            (item, outputKey, filename?): string | undefined => {
                if (outputKey === "transformed") {
                    return this.getTransformedPath(item, context);
                }
                else if (outputKey === "result-documents") {
                    // Without filename: can't recalculate, return undefined (use cached structure)
                    if (!filename) {
                        return undefined;
                    }

                    // With filename: can calculate path (used during performWork)
                    const transformedPath = this.getTransformedPath(item, context);
                    const baseDir = path.dirname(transformedPath);
                    const resultPath = path.normalize(path.join(baseDir, filename));

                    // Security: ensure result stays within node's build directory
                    if (!resultPath.startsWith(baseDir)) {
                        throw new Error(`Result-document path escapes build directory: ${filename}`);
                    }

                    return resultPath;
                }
                throw new Error(`Unknown output key: ${outputKey}`);
            },
            async (sourcePath) => {

                const outputPath = this.getTransformedPath(sourcePath, context);

                // TODO: maybe we can get document() calls from SaxonJs getPlatform().readFile
                const transformOptions: any = {
                    stylesheetFileName: sefStylesheetPath,
                    destination: 'serialized',
                    collectionFinder: (uri: string) => {
                        let collectionPath = uri
                        if (collectionPath.startsWith('file:')) {
                            collectionPath = collectionPath.substring(5);
                        }
                        context.log(`  - Collection finder: ${collectionPath}`);
                        const files = fsSync.globSync(collectionPath);
                        const results = files.map(file => {
                            const content = fsSync.readFileSync(file, 'utf-8');
                            const doc = platform.parseXmlFromString(content);
                            // Set the document URI property that SaxonJS uses for document-uri()
                            // This matches how SaxonJS sets _saxonDocUri when loading documents
                            (doc as any)._saxonDocUri = `file://${path.resolve(file)}`;
                            return doc;
                        })
                        context.log(`  - Collection finder: ${results.length} files found`);
                        return results
                    },
                    deliverResultDocument: () => ({
                        destination: "serialized",
                    }),
                    ...this.config.config.initialTemplate ? {initialTemplate: this.config.config.initialTemplate} : {},
                    ...this.config.config.stylesheetParams ? {stylesheetParams: await this.resolveStylesheetParams(context, sourcePath)} : {},
                    ...this.config.config.initialMode ? {initialMode: this.config.config.initialMode} : {},
                    ...this.config.config.serializationParams ? {outputProperties: this.config.config.serializationParams} : {},
                };

                if (!isNoSourceMode) {
                    transformOptions.sourceFileName = sourcePath;
                }

                const result = await transform(transformOptions);

                // Write principal result
                await fs.mkdir(path.dirname(outputPath), { recursive: true });
                await fs.writeFile(outputPath, result.principalResult);
                context.log(`  - Generated: ${outputPath}`);

                // Handle result documents (xsl:result-document outputs)
                // XSLT controls relative path structure via href attribute
                const resultDocumentPaths: string[] = [];
                if (result.resultDocuments) {
                    const baseDir = path.dirname(outputPath);

                    for (const [uri, content] of Object.entries(result.resultDocuments)) {
                        // uri contains XSLT-relative path (e.g., "result-documents/bib-123.xml" or just "bib-123.xml")
                        const relativePath = uri.startsWith('file://') ? uri.substring(7) : uri;
                        const docPath = path.normalize(path.join(baseDir, relativePath));

                        // Security: ensure result stays within node's build directory
                        if (!docPath.startsWith(baseDir)) {
                            throw new Error(`Result-document path escapes build directory: ${relativePath}`);
                        }

                        // Ensure subdirectories exist (XSLT might specify nested paths)
                        await fs.mkdir(path.dirname(docPath), { recursive: true });
                        await fs.writeFile(docPath, content as string);
                        resultDocumentPaths.push(docPath);
                        context.log(`  - Result document: ${docPath}`);
                    }
                }

                // TODO: Future improvement - use getOutputPath directly in deliverResultDocument callback
                // This would make Saxon call getOutputPath when writing result-documents, ensuring
                // consistency between cache miss (writing) and cache hit (path recalculation)

                return {
                    outputs: {
                        transformed: [outputPath],
                        "result-documents": resultDocumentPaths
                    }
                };
            }
        );

        return results.map(r => r.outputs);
    }

    private async resolveStylesheetParams(context: PipelineContext, sourcePath: string): Promise<Record<string, any>> {
        if (!this.config.config.stylesheetParams) return {};

        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(this.config.config.stylesheetParams)) {
            if (typeof value === 'function') {
                resolved[key] = value(sourcePath);
            } else if (inputIsNodeOutputReference(value)) {
                resolved[key] = await context.resolveInput(value);
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }
}