import {type Input, type PipelineContext, PipelineNode, type PipelineNodeConfig} from "../core/pipeline";
import path from "node:path";
import fs from "node:fs/promises";

import FlexSearch from 'flexsearch';

interface FlexSearchIndexConfig extends PipelineNodeConfig {
    items: Input;  // documentsJson files
    config: Record<string, any>;  // No processing config needed
    outputConfig?: {
        outputDir?: string;
    };
}

export class FlexSearchIndexNode extends PipelineNode<FlexSearchIndexConfig, "searchIndex"> {
    async run(context: PipelineContext) {
        const jsonFiles = await context.resolveInput(this.items!);
        if (jsonFiles.length !== 1) {
            throw new Error("FlexSearchIndexNode requires exactly one JSON input file");
        }

        const jsonFile = jsonFiles[0];
        const outputDir = this.config.outputConfig?.outputDir || context.getBuildPath(this.name, jsonFile);

        this.log(context, `Generating FlexSearch index from ${jsonFile}`);

        // Load documents
        const jsonContent = await fs.readFile(jsonFile, 'utf-8');
        const documents = JSON.parse(jsonContent);

        this.log(context, `Processing ${documents.length} documents`);

        // Create FlexSearch index (text search + document storage)
        const indexConfig = {
            id: 'num_id',
            store: true,  // Store full documents for .get() retrieval
            // TODO make configurable!
            index: [
                'text', 'lemmatised_text'
            ],
            tag: [ 'document_title',
                'found_provenance', 'source_repository', 'support_material',
                'support_object_type', 'text_type', 'language', 'origin_date']
        };
        const searchIndex = new FlexSearch.Document(indexConfig);

        // Add documents to index
        documents.forEach((doc: any, i: number) => {
            // Add numeric ID and flatten text arrays
            const indexDoc = {
                num_id: i,
                ...doc,

                // TODO: not sure why we are flattening arrays
                text: Array.isArray(doc.text) ? doc.text.join(' ') : doc.text,
                document_title: Array.isArray(doc.document_title) ? doc.document_title.join(' ') : doc.document_title
            };
            searchIndex.add(indexDoc);
        });

        // Export and save
        await fs.mkdir(outputDir, { recursive: true });

        // Generate facet counts for JavaScript filtering
        const facets = this.generateFacets(documents);

        // Write facets and metadata
        await fs.writeFile(path.join(outputDir, 'facets.json'), JSON.stringify(facets, null, 2));
        await fs.writeFile(path.join(outputDir, 'count.json'), JSON.stringify({ total: documents.length }));
        await fs.writeFile(path.join(outputDir, 'config.json'), JSON.stringify(indexConfig))

        const writtenFiles: string[] = []
        await searchIndex.export(async (key: string, data: any) => {
            await fs.writeFile(path.join(outputDir, key), data, "utf8");
            writtenFiles.push(key)
        });
        await fs.writeFile(path.join(outputDir, 'index.json'), JSON.stringify(writtenFiles, null, 2));

        this.log(context, `FlexSearch index generated: ${outputDir}`);
        return [{ searchIndex: [...writtenFiles, 'facets.json', 'count.json', 'config.json', 'index.json' ].map(file => path.join(outputDir, file)) }];
    }

    private generateFacets(documents: any[]): Record<string, Record<string, number>> {
        const facets: Record<string, Record<string, number>> = {};

        // TODO: make facet fields configurable
        const facetFields = ['support_material', 'support_object_type', 'found_provenance',
                            'source_repository', 'text_type', 'language', 'origin_date_evidence'];

        facetFields.forEach(field => {
            facets[field] = {};
            documents.forEach(doc => {
                const values = Array.isArray(doc[field]) ? doc[field] : [doc[field]];
                values.forEach((value: string) => {
                    if (value?.trim()) {
                        facets[field][value] = (facets[field][value] || 0) + 1;
                    }
                });
            });
        });

        return facets;
    }
}