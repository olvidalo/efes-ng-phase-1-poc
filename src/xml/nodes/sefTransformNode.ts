import {
    type Input,
    type PipelineContext,
    PipelineNode,
    type PipelineNodeConfig
} from "../../core/pipeline";
import path from "node:path";
import fs from "node:fs/promises";
import fsSync from "node:fs";

// @ts-ignore
import {transform} from 'saxonjs-he';

// Register Kiln extension functions at module load
// @ts-ignore
import SaxonJS from 'saxonjs-he';

// Register the kiln:url-for-match function implementation
SaxonJS.registerExtensionFunctions({
    "namespace": "http://www.kcl.ac.uk/artshums/depts/ddh/kiln/ns/1.0",
    "signatures": {
        "url-for-match": {
            "as": "xs:string",
            "param": ["xs:string", "xs:string*", "xs:integer"],
            "arity": [3],
            "impl": function(matchId: string, params: any, priority: number): string {
                // Simple implementation: generate static URLs based on parameters
                // matchId is like 'local-epidoc-display-html'
                // params is an iterator of [language, filename]
                const paramArray = Array.from(params);
                console.log(paramArray)
                console.log(`url-for-match(${matchId}, ${paramArray}, ${priority})`);
                const language = paramArray[0] || 'en';
                const filename = paramArray[1] || 'unknown';

                if (matchId === 'local-epidoc-display-html') {
                    const result = `/${language}/inscriptions/${filename}.html`;
                    console.log(`RETURNING ABSOLUTE: ${result}`);
                    return result;
                }

                // Fallback for other match IDs
                return `/${language}/${filename}.html`;
            }
        }
    }
});


interface SefTransformConfig extends PipelineNodeConfig {
    inputs: {
        sefStylesheet: Input;
        sourceXml?: Input;
    };
    outputFilenameMapping?: (inputPath: string) => string;
    resultDocumentsDir?: string;
    initialTemplate?: string;
    stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
    initialMode?: string;
}

export class SefTransformNode extends PipelineNode<SefTransformConfig, "transformed" | "result-documents"> {

    private defaultOutputFilenameMapping = (inputPath: string) => {
        const inputFilename = path.basename(inputPath);
        const inputDirname = path.dirname(inputPath);
        const inputBasename = path.basename(inputFilename, path.extname(inputFilename));
        return path.join(inputDirname, inputBasename + '.html');
    }

    async run(context: PipelineContext) {
        const sefStylesheetPath = (await context.resolveInput(this.inputs.sefStylesheet))[0];

        // Handle no-source mode (stylesheet uses document() for input)
        const sourcePaths = this.inputs.sourceXml ?
            await context.resolveInput(this.inputs.sourceXml) :
            [sefStylesheetPath];

        const isNoSourceMode = !this.inputs.sourceXml;
        context.log(`${isNoSourceMode ? 'Running stylesheet' : `Transforming ${sourcePaths.length} file(s)`} with ${sefStylesheetPath}`);

        const outputFilenameMapper = this.config.outputFilenameMapping ??
            ((inputPath: string) => context.getBuildPath(this.name, inputPath, '.html'));

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

        const results = await this.withCache(
            context,
            sourcePaths,
            (item) => isNoSourceMode ? `no-source-${sefStylesheetPath}` : `${item}-with-${sefStylesheetPath}`,
            (item) => isNoSourceMode ?
                (this.config.outputFilenameMapping?.(sefStylesheetPath) ?? context.getBuildPath(this.name, sefStylesheetPath, '.html')) :
                outputFilenameMapper(item),
            async (sourcePath) => {

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
                    ...this.config.initialTemplate ? {initialTemplate: this.config.initialTemplate} : {},
                    ...this.config.stylesheetParams ? {stylesheetParams: this.resolveStylesheetParams(sourcePath)} : {},
                    ...this.config.initialMode ? {initialMode: this.config.initialMode} : {},
                };

                if (!isNoSourceMode) {
                    transformOptions.sourceFileName = sourcePath;
                }

                const result = await transform(transformOptions);
                const outputPath = isNoSourceMode ?
                    (this.config.outputFilenameMapping?.(sefStylesheetPath) ?? sefStylesheetPath.replace('.sef.json', '.html')) :
                    outputFilenameMapper(sourcePath);

                // Ensure directory exists before writing
                await fs.mkdir(path.dirname(outputPath), { recursive: true });
                await fs.writeFile(outputPath, result.principalResult);
                context.log(`  - Generated: ${outputPath}`);
            }
        );

        return results.map(r => ({
            transformed: [r.output],
            "result-documents": []
        }));
    }

    private resolveStylesheetParams(sourcePath: string): Record<string, any> {
        if (!this.config.stylesheetParams) return {};

        const resolved: Record<string, any> = {};
        for (const [key, value] of Object.entries(this.config.stylesheetParams)) {
            if (typeof value === 'function') {
                resolved[key] = value(sourcePath);
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }
}