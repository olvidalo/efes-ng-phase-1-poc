import { PipelineNode, type PipelineNodeConfig, type NodeOutput, type PipelineContext } from "./pipeline";

/**
 * Mapping configuration for connecting internal node outputs to composite node outputs
 */
export interface OutputMapping {
    /** Name of the internal node providing the output */
    node: string;
    /** Name of the output from that internal node */
    output: string;
}

/**
 * Base class for composite nodes that internally orchestrate other nodes.
 *
 * Composite nodes create internal nodes that get expanded into the main pipeline.
 * This allows complex multi-step operations to be encapsulated as a single logical node
 * while maintaining full visibility for streaming and parallelization.
 *
 * @example
 * ```typescript
 * class MyCompositeNode extends CompositeNode<Config, "result"> {
 *     protected buildInternalNodes() {
 *         const step1 = new ProcessNode({
 *             name: `${this.name}-process`,
 *             inputs: {...}
 *         });
 *
 *         const step2 = new TransformNode({
 *             name: `${this.name}-transform`,
 *             inputs: {
 *                 data: from(step1, "processed")
 *             }
 *         });
 *
 *         this.internalNodes = [step1, step2];
 *
 *         this.outputMappings = {
 *             "result": { node: step2.name, output: "transformed" }
 *         };
 *     }
 * }
 * ```
 */
export abstract class CompositeNode<
    TConfig extends PipelineNodeConfig,
    TOutput extends string
> extends PipelineNode<TConfig, TOutput> {
    /** Internal nodes that will be expanded into the main pipeline */
    protected internalNodes: PipelineNode<any, any>[] = [];

    /** Mappings from internal node outputs to this node's outputs */
    protected outputMappings: Record<string, OutputMapping> = {};

    constructor(config: TConfig) {
        super(config);
        // Build internal nodes at construction time
        this.buildInternalNodes();
    }

    /**
     * Subclasses must implement this to create their internal nodes
     * and configure output mappings.
     */
    protected abstract buildInternalNodes(): void;

    /**
     * Lifecycle hook called when this composite node is added to a pipeline.
     * Expands internal nodes into the main pipeline for streaming and parallelization.
     */
    onAddedToPipeline(pipeline: any): void {
        console.log(`Expanding composite node: ${this.name}`);
        for (const node of this.internalNodes) {
            pipeline.addNode(node);
        }

        // Add dependencies from composite to internal nodes so composite runs AFTER internal nodes
        for (const node of this.internalNodes) {
            try {
                pipeline.graph.addDependency(this.name, node.name);
            } catch (err: any) {
                // Dependency might already exist or have other issues, continue
                console.warn(`Could not add dependency from ${this.name} to ${node.name}: ${err.message}`);
            }
        }
    }

    /**
     * Collects outputs from internal nodes according to the configured mappings.
     * By the time this runs, all internal nodes have already executed as part
     * of the main pipeline.
     */
    async run(context: PipelineContext): Promise<NodeOutput<TOutput>[]> {
        return this.collectMappedOutputs(context);
    }

    /**
     * Collects outputs from internal nodes and maps them to this node's outputs
     * according to the configured output mappings.
     */
    private collectMappedOutputs(context: PipelineContext): NodeOutput<TOutput>[] {
        const results: NodeOutput<TOutput>[] = [];

        for (const [ourOutputName, mapping] of Object.entries(this.outputMappings)) {
            const internalNodeOutputs = context.getNodeOutputs(mapping.node);

            if (internalNodeOutputs) {
                // Find the specific output from the internal node
                for (const nodeOutput of internalNodeOutputs) {
                    const outputValue = nodeOutput[mapping.output];
                    if (outputValue !== undefined) {
                        // Map to our output name
                        results.push({
                            [ourOutputName]: outputValue
                        } as NodeOutput<TOutput>);
                    }
                }
            } else {
                throw new Error(
                    `CompositeNode ${this.name}: Could not find outputs from internal node "${mapping.node}" for output "${ourOutputName}". ` +
                    `Make sure the internal node exists and has run.`
                );
            }
        }

        if (results.length === 0) {
            console.warn(`CompositeNode ${this.name}: No outputs collected from internal pipeline`);
        }

        return results;
    }


    /**
     * Get the internal nodes for inspection/debugging
     */
    getInternalNodes(): PipelineNode<any, any>[] {
        return [...this.internalNodes];
    }
}