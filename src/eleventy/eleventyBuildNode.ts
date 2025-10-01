import {type Input, type PipelineContext, PipelineNode, type PipelineNodeConfig} from "../core/pipeline";
import path from "node:path";
import fs from "node:fs/promises";

// @ts-ignore
import {Eleventy} from '@11ty/eleventy';

interface EleventyBuildConfig extends PipelineNodeConfig {
    name: string;
    inputs: {
        sourceFiles?: Input;
    };
    sourceDir: string;
    outputDir?: string;
    eleventyConfig?: any;
}

export class EleventyBuildNode extends PipelineNode<EleventyBuildConfig, "built"> {
    constructor(config: EleventyBuildConfig) {
        super(config);

        // Validate that source directory is provided
        if (!this.config.sourceDir) {
            throw new Error(`EleventyBuildNode "${this.name}" requires sourceDir configuration`);
        }
    }

    async run(context: PipelineContext) {
        const sourceDir = path.resolve(this.config.sourceDir);

        // Check if source directory exists
        try {
            await fs.access(sourceDir);
        } catch {
            throw new Error(`Source directory not found: ${sourceDir}`);
        }

        // Determine output directory
        const outputDir = this.config.outputDir ?
            path.resolve(this.config.outputDir) :
            context.getBuildPath(this.name, sourceDir);

        context.log(`Building Eleventy site: ${sourceDir} -> ${outputDir}`);

        // For now, don't use caching since we're dealing with directories
        // TODO: Implement proper directory-based caching

        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });

        // Initialize Eleventy
        const elev = new Eleventy(sourceDir, outputDir, {
            ...this.config.eleventyConfig,
        });


        // Run the build
        await elev.write();

        context.log(`  - Eleventy build completed: ${outputDir}`);

        const results = [{ item: sourceDir, output: outputDir, cached: false }];

        return [{ built: [results[0].output] }];
    }
}