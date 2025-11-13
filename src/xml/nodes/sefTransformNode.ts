import {
    type FileRef,
    type Input,
    inputIsNodeOutputReference,
    type PipelineContext,
    PipelineNode,
    type PipelineNodeConfig,
    type UnifiedOutputConfig
} from "../../core/pipeline";
import path from "node:path";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

interface SefTransformConfig extends PipelineNodeConfig {
    config: {
        sourceFiles?: Input;  // sourceXml files (optional for no-source transforms)
        sefStylesheet: FileRef | Input;  // Can be FileRef or NodeOutputReference
        initialTemplate?: string;
        stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
        tunnelParams?: Record<string, any | ((inputPath: string) => any)>;
        templateParams?: Record<string, any | ((inputPath: string) => any)>;
        // TODO: passing {indent: false} indents anyway
        serializationParams?: Record<string, any>;
        initialMode?: string;
    };
    outputConfig?: UnifiedOutputConfig;
}


export class SefTransformNode extends PipelineNode<SefTransformConfig, "transformed" | "result-documents"> {

    // Helper: Calculate transformed output path using unified path handling
    private getTransformedPath(item: string, context: PipelineContext): string {
        const config = this.config.outputConfig ?? {};
        // Default extension is .xml for transforms (XSLT standard)
        const defaultExt = config.extension ?? '.xml';
        return this.calculateOutputPath(item, context, config, defaultExt);
    }

    async run(context: PipelineContext) {
        // const startTime = Date.now();

        // Handle both FileRef and Input (NodeOutputReference) for sefStylesheet
        // this.log(context, `[DEBUG] Resolving SEF stylesheet reference...`);
        // const resolveStartTime = Date.now();
        const sefStylesheetPath = (this.config.config.sefStylesheet as any).path
            ? (this.config.config.sefStylesheet as FileRef).path
            : (await context.resolveInput(this.config.config.sefStylesheet as Input))[0];
        // this.log(context, `[DEBUG] SEF stylesheet resolved in ${Date.now() - resolveStartTime}ms: ${sefStylesheetPath}`);

        // this.log(context, `[DEBUG] Loading SEF stylesheet JSON...`);
        // const loadStartTime = Date.now();
        const sefStylesheetJson = await readFile(sefStylesheetPath, 'utf-8')
        const sefStylesheet = JSON.parse(sefStylesheetJson)
        // this.log(context, `[DEBUG] SEF stylesheet loaded in ${Date.now() - loadStartTime}ms`);

        // Handle no-source mode (stylesheet uses document() for input)
        // this.log(context, `[DEBUG] Resolving input items...`);
        // const itemsStartTime = Date.now();
        const sourcePaths = this.config.config.sourceFiles ?
            await context.resolveInput(this.config.config.sourceFiles) :
            [sefStylesheetPath];
        // this.log(context, `[DEBUG] Input items resolved in ${Date.now() - itemsStartTime}ms: ${sourcePaths.length} file(s)`);

        const isNoSourceMode = !this.config.config.sourceFiles;
        // this.log(context, `${isNoSourceMode ? 'Running stylesheet' : `Transforming ${sourcePaths.length} file(s)`} with ${sefStylesheetPath}`);

        // this.log(context, `[DEBUG] Starting withCache processing...`);
        // const cacheStartTime = Date.now();
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
                // this.log(context, `[DEBUG] Transforming item: ${sourcePath}`);
                // const itemStartTime = Date.now();

                const outputPath = this.getTransformedPath(sourcePath, context);
                const baseDir = path.dirname(outputPath);

                // this.log(context, `[DEBUG] Resolving stylesheet params...`);
                // const paramsStartTime = Date.now();
                const stylesheetParams = await this.resolveStylesheetParams(context, sourcePath);
                // this.log(context, `[DEBUG] Stylesheet params resolved in ${Date.now() - paramsStartTime}ms`);

                // Prepare transform options for worker (no callbacks - they're in the worker)
                const transformOptions = {
                    initialTemplate: this.config.config.initialTemplate,
                    stylesheetParams,
                    tunnelParams: this.config.config.tunnelParams,
                    templateParams: this.config.config.templateParams,
                    initialMode: this.config.config.initialMode,
                    outputProperties: this.config.config.serializationParams
                };

                // Execute transform in worker thread
                // Determine workload script path based on environment
                const currentDir = path.dirname(fileURLToPath(import.meta.url));
                const devWorkloadPath = path.resolve(currentDir, '../saxonWorkload.ts');
                const prodWorkloadPath = path.resolve(currentDir, 'xml/saxonWorkload.js');
                const workloadScript = fs.existsSync(prodWorkloadPath) ? prodWorkloadPath : devWorkloadPath;

                // this.log(context, `[DEBUG] Executing transform in worker thread...`);
                // const workerStartTime = Date.now();
                const result = await context.workerPool.execute<{
                    outputPath: string;
                    resultDocumentPaths: string[];
                }>({
                    workloadScript,
                    nodeName: this.name,
                    sourcePath: isNoSourceMode ? null : sourcePath,
                    sefStylesheetPath,
                    stylesheetInternal: sefStylesheet,
                    outputPath,
                    baseDir,
                    transformOptions
                });
                // this.log(context, `[DEBUG] Transform completed in ${Date.now() - workerStartTime}ms`);

                this.log(context, `Generated: ${result.outputPath}`);
                for (const docPath of result.resultDocumentPaths) {
                    this.log(context, `Result document: ${docPath}`);
                }

                // this.log(context, `[DEBUG] Item transformation total time: ${Date.now() - itemStartTime}ms`);

                return {
                    outputs: {
                        transformed: [result.outputPath],
                        "result-documents": result.resultDocumentPaths
                    }
                };
            }
        );
        // this.log(context, `[DEBUG] withCache processing completed in ${Date.now() - cacheStartTime}ms`);
        // this.log(context, `[DEBUG] Total run() time: ${Date.now() - startTime}ms`);

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