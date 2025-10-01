import {type Input, type PipelineContext, PipelineNode, type PipelineNodeConfig} from "../../core/pipeline";
import path from "node:path";
import {fork} from "child_process";
import fs from "node:fs/promises";

// @ts-ignore
import {getResource, XPath} from 'saxonjs-he';


interface CompileStylesheetConfig extends PipelineNodeConfig {
    name: string;
    inputs: { xslt: Input };
    outputFilename?: string;
}

// TODO: need to preserve the original path somehow, maybe
export class CompileStylesheetNode extends PipelineNode<CompileStylesheetConfig, "compiledStylesheet"> {
    async run(context: PipelineContext) {
        const xsltPath = await context.resolveInput(this.inputs.xslt);
        if (xsltPath.length !== 1) throw new Error("Multiple xslt input files not supported");

        const sefPath = this.config.outputFilename ?
            path.resolve(this.config.outputFilename) :
            context.getBuildPath(this.name, xsltPath[0], '.sef.json');

        const results = await this.withCache(
            context,
            xsltPath,
            (item) => item,
            () => sefPath,
            async (item) => {
                context.log(`Compiling ${item} to ${sefPath}`);

                // Extract XSLT dependencies before compilation
                const discoveredDependencies = await this.extractXsltDependencies(item);
                context.log(`  Found ${discoveredDependencies.length} dependencies: ${JSON.stringify(discoveredDependencies)}`);

                try {
                    await new Promise<void>((resolve, reject) => {
                        const xslt3Path = require.resolve('xslt3-he');

                        const child = fork(xslt3Path, [
                            `-xsl:${xsltPath[0]}`,
                            `-export:${sefPath}`,
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
                                console.log(`Successfully compiled: ${path.basename(sefPath)}`);
                                resolve();
                            } else {
                                reject(new Error(`XSLT compilation failed with exit code ${code}\nstderr: ${stderr}`));
                            }
                        });

                        child.on('error', (err) => {
                            reject(new Error(`Failed to fork xslt3 process: ${err.message}`));
                        });
                    });

                    return {discoveredDependencies};
                } catch (err: any) {
                    throw new Error(`Failed to compile XSL: ${err.message}`);
                }
            }
        );

        return [{compiledStylesheet: [results[0].output]}];
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