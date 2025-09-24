import * as fs from "node:fs/promises";
import * as path from "node:path";
import {fork} from "child_process";
import { DepGraph }  from "dependency-graph"
import { glob } from "glob";


// TODO: Maybe use Async Generators instead of promises and implement streaming

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { transform } = require('saxon-js');


interface NodeOutputReference {
    node: PipelineNode<any, any>;
    name: string;
}

function inputIsNodeOutputReference(input: Input): input is NodeOutputReference {
    return typeof input === 'object' && 'node' in input && 'name' in input;
}


type Input = string | string[] | NodeOutputReference;

type NodeOutput<TKey extends string> = Record<TKey, string[]>;

export function from<TNode extends PipelineNode<any, TOutput>, TOutput extends string>(node: TNode, output: TOutput): NodeOutputReference {
    return { node, name: output as string};
}


interface PipelineNodeConfig {
    name: string;
    inputs: Record<string, Input>;
}

abstract class PipelineNode<TConfig extends PipelineNodeConfig = PipelineNodeConfig, TOutput extends string = string> {
    constructor(public readonly config: TConfig) {}

    get name() { return this.config.name; }
    get inputs(): TConfig["inputs"] { return this.config.inputs; }

    abstract run(context: PipelineContext): Promise<NodeOutput<TOutput>[]>;
}

interface PipelineContext {
    resolveInput(input: Input): Promise<string[]>;
    log(message: string): void;
}

export class Pipeline {
    private graph = new DepGraph<PipelineNode>();
    private nodeOutputs = new Map<string, NodeOutput<any>[]>;

    constructor(public readonly name: string) { }

    addNode(node: PipelineNode<any, any>): this {
        this.graph.addNode(node.name, node);
        return this;
    }

    private setupDependencies() {
        for (const nodeName of this.graph.entryNodes()) {
            const node = this.graph.getNodeData(nodeName);
            for (const [_, input] of Object.entries(node.inputs)) {
                if (typeof input === 'object' && 'node' in input) {
                    try {
                        console.log(`Adding dependency for node ${node.name}: ${input.node.name}`);
                        this.graph.addDependency(node.name, input.node.name);
                    } catch (err: any) {
                        throw new Error(`Failed to add dependency for node ${node.name}: ${err.message}`);
                    }
                }
            }
        }
    }

    async run() {
        console.log(`Running pipeline ${this.name}`);
        console.log(`Number of nodes: ${this.graph.size}`);
        this.setupDependencies();

        const executionOrder = this.graph.overallOrder();
        console.log(executionOrder)
        const context: PipelineContext = {
            resolveInput: async (input: Input): Promise<string[]> => {

                // Node references
                if (inputIsNodeOutputReference(input)) {
                    const outputs = this.nodeOutputs.get(input.node.name)?.flatMap(output => output[input.name]);
                    if (!outputs) {
                        throw new Error(`Node "${input.node.name}" hasn't run yet or has not produced any outputs.`);
                    }
                    return outputs
                }

                // File paths
                if (typeof input === "string") {
                    const results = await glob(input)
                    if (results.length === 0) {
                        throw new Error(`No files found for pattern: ${input}`);
                    }
                    return results
                }

                // Arrays of node references or file paths
                if (Array.isArray(input)) {
                    const results: string[] = [];
                    for (const item of input) {
                        results.push(...(await context.resolveInput(item)))
                    }
                    return results;
                }

                return []
            },
            log: (message: string) => console.log(`  [${this.name}] ${message}`)
        }

        for (const nodeName of executionOrder) {
            const node = this.graph.getNodeData(nodeName);
            context.log(`▶ Running node: ${node.name}`);

            // const outputs: NodeOutput<any>[] = [];
            try {
                // for await (const output of node.run(context)) {
                //     outputs.push(output);
                //     context.log(`  → Generated: ${JSON.stringify(output, null, 2)}`);
                // }
                const output = await node.run(context);
                context.log(`  → Generated: ${JSON.stringify(output, null, 2)}`);

                this.nodeOutputs.set(node.name, output);
                context.log(`  - Completed: ${node.name}`);
            } catch (err: any) {
                context.log(`  - Failed: ${node.name}`);
                context.log(`    ${err.message}`);
                throw err;
            }
        }

        context.log(`Pipeline completed.`);
    }
}

interface CompileStylesheetConfig extends PipelineNodeConfig {
    name: string;
    inputs: { xslt: Input };
    outputFilename: string;
}


export class CompileStylesheetNode extends PipelineNode<CompileStylesheetConfig, "compiledStylesheet"> {
    async run(context: PipelineContext) {
        const xsltPath = await context.resolveInput(this.inputs.xslt);

        // TODO error handling if not exists, can't be read etc
        console.log(this.inputs)
        console.log(xsltPath)
        if (xsltPath.length !== 1) throw new Error("Multiple xslt input files not supported")

        const sefDir = path.dirname(path.resolve(this.config.outputFilename));
        const sefFilename = path.basename(this.config.outputFilename);
        const sefPath = path.join(sefDir, sefFilename);

        context.log(`Compiling ${xsltPath[0]} to ${sefPath}`);
        try {
            await new Promise<void>((resolve, reject) => {
                const xslt3Path = require.resolve('xslt3');

                const child = fork(xslt3Path, [
                    `-xsl:${xsltPath[0]}`,
                    `-export:${sefPath}`,
                    '-relocate:on',
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
                        console.log(`Successfully compiled: ${path.basename(sefDir)}`);
                        resolve();
                    } else {
                        reject(new Error(`XSLT compilation failed with exit code ${code}\nstderr: ${stderr}`));
                    }
                });

                child.on('error', (err) => {
                    reject(new Error(`Failed to fork xslt3 process: ${err.message}`));
                });
            });
        } catch (err: any) {
            throw new Error(`Failed to compile XSL: ${err.message}`);
        }

        return [{ compiledStylesheet: [sefPath] }];
    }
}

// const n = new CompileStylesheetNode({
//     name: "asdf",
//     outputFilename: "sdf",
//     inputs: {xslt: "adsf.xsl"}
// })
//
// from(n, "compiledStylesheet")

interface XsltTransformConfig extends PipelineNodeConfig {
    name: string;
    inputs: {
        sefStylesheet: Input;
        sourceXml: Input;
    };
    outputFilenameMapping?: (inputPath: string) => string;
    resultDocumentsDir?: string;
}

export class XsltTransformNode extends PipelineNode<XsltTransformConfig, "transformed" | "result-documents"> {
    private defaultOutputFilenameMapping = (inputPath: string) => {
        const inputFilename = path.basename(inputPath);
        const inputDirname = path.dirname(inputPath);
        const inputBasename = path.basename(inputFilename, path.extname(inputFilename));
        return path.join(inputDirname, inputBasename + '.html');
    }

    async run(context: PipelineContext) {
        const sefStylesheetPath = await context.resolveInput(this.inputs.sefStylesheet);
        const sourcePaths = await context.resolveInput(this.inputs.sourceXml);

        context.log(`Transforming ${sourcePaths.length} file(s) with ${sefStylesheetPath}`);
        const transformed = []
        for (const sourcePath of sourcePaths) {
            // const filename = path.basename(sourcePath);
            // const basename = path.basename(filename, path.extname(filename));
            // const resultPath = path.join(this.config.resultDocumentsDir ?? '', basename + '.html');

            const result = await transform({
                stylesheetFileName: sefStylesheetPath[0],
                sourceFileName: sourcePath,
                destination: 'serialized'
            })

            const outputFilenameMapper = this.config.outputFilenameMapping ?? this.defaultOutputFilenameMapping;
            const outputPath = outputFilenameMapper(sourcePath);
            await fs.writeFile(outputPath, result.principalResult);

            transformed.push({
                transformed: [outputPath],
                "result-documents": []
            });
        }

        return transformed;
    }
}