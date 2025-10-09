import {type Input, type PipelineContext, PipelineNode, type PipelineNodeConfig} from "../../core/pipeline";
import path from "node:path";
import {fork} from "child_process";
import fs from "node:fs/promises";

// @ts-ignore
import {getResource, XPath} from 'saxonjs-he';


interface CompileStylesheetConfig extends PipelineNodeConfig {
    items: Input;  // xslt files to compile
    config: Record<string, any>;  // No processing config needed
    outputConfig?: {
        outputDir?: string;
        outputFilename?: string;
    };
}

// TODO: need to preserve the original path somehow, maybe
export class CompileStylesheetNode extends PipelineNode<CompileStylesheetConfig, "compiledStylesheet"> {

    // Helper: Calculate compiled output path
    private getCompiledPath(item: string, context: PipelineContext): string {
        // If explicit outputDir specified, all paths are relative to it
        if (this.config.outputConfig?.outputDir) {
            const outputDir = this.config.outputConfig.outputDir;

            // Custom filename is relative to outputDir
            if (this.config.outputConfig.outputFilename) {
                return path.join(outputDir, this.config.outputConfig.outputFilename);
            }

            // Default: preserve relative path structure from source (strip build prefix)
            const basename = path.basename(item, path.extname(item));
            const relativePath = this.getCleanRelativePath(item, context);
            return path.join(outputDir, relativePath, basename + '.sef.json');
        }

        // No outputDir: use default build directory logic via getBuildPath
        if (this.config.outputConfig?.outputFilename) {
            return path.join(context.buildDir, this.name, this.config.outputConfig.outputFilename);
        }

        return context.getBuildPath(this.name, item, '.sef.json');
    }

    async run(context: PipelineContext) {
        const xsltPaths = await context.resolveInput(this.items!);

        const results = await this.withCache<"compiledStylesheet">(
            context,
            xsltPaths,
            (item) => item,
            () => {
                // Output base directory
                return this.config.outputConfig?.outputDir ??
                       path.join(context.buildDir, this.name);
            },
            (item, outputKey, filename?): string | undefined => {
                if (outputKey === "compiledStylesheet") {
                    return this.getCompiledPath(item, context);
                }
                throw new Error(`Unknown output key: ${outputKey}`);
            },
            async (item) => {
                const outputPath = this.getCompiledPath(item, context);

                context.log(`Compiling ${item} to ${outputPath}`);

                // Extract XSLT dependencies before compilation
                const discoveredDependencies = await this.extractXsltDependencies(item);
                context.log(`  Found ${discoveredDependencies.length} dependencies: ${JSON.stringify(discoveredDependencies)}`);

                try {
                    await new Promise<void>((resolve, reject) => {
                        const xslt3Path = require.resolve('xslt3-he');

                        const child = fork(xslt3Path, [
                            `-xsl:${item}`,
                            `-export:${outputPath}`,
                            // TODO: find out whether we should rather produce relocatable stylesheets
                            //       and have the user provide the base URI in the xslt transform node configuration
                            // '-relocate:on',
                            `-stublib:${path.resolve('kiln-functions-stub.json')}`,  // Register extension function signatures
                            '-nogo'
                        ], {
                            silent: true // Capture stdio
                        });

                        let stdout = '';
                        let stderr = '';

                        if (child.stdout) {
                            child.stdout.on('data', (data) => {
                                stdout += data.toString();
                            });
                        }

                        if (child.stderr) {
                            child.stderr.on('data', (data) => {
                                stderr += data.toString();
                            });
                        }

                        child.on('close', (code) => {
                            if (code === 0) {
                                console.log(`Successfully compiled: ${path.basename(outputPath)}`);
                                resolve();
                            } else {
                                reject(new Error(`XSLT compilation failed with exit code ${code}\nstderr: ${stderr}`));
                            }
                        });

                        child.on('error', (err) => {
                            reject(new Error(`Failed to fork xslt3 process: ${err.message}`));
                        });
                    });

                    return {
                        outputs: {
                            compiledStylesheet: [outputPath]
                        },
                        discoveredDependencies
                    };
                } catch (err: any) {
                    throw new Error(`Failed to compile XSL: ${err.message}`);
                }
            }
        );

        return results.map(r => r.outputs);
    }

    private async extractXsltDependencies(xsltPath: string): Promise<string[]> {
        const allDependencies = new Set<string>();
        const processed = new Set<string>();

        async function processFile(filePath: string) {
            if (processed.has(filePath)) return;
            processed.add(filePath);

            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const doc = await getResource({text: content, type: 'xml'});

                // Use XPath to find xsl:import and xsl:include elements
                const imports = XPath.evaluate("//(xsl:import|xsl:include)/@href/data(.)", doc, {
                    namespaceContext: {xsl: 'http://www.w3.org/1999/XSL/Transform'},
                    resultForm: 'array'
                });

                for (const href of imports) {
                    const resolvedPath = path.resolve(path.dirname(filePath), href);
                    allDependencies.add(resolvedPath);
                    await processFile(resolvedPath); // Recursively process dependencies
                }
            } catch (error) {
                console.warn(`Could not parse XSLT dependencies from ${filePath}:`, error);
            }
        }

        await processFile(xsltPath);
        return Array.from(allDependencies);
    }
}