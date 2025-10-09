import {from, type Input, type PipelineNodeConfig, type FileRef} from "../../core/pipeline";
import {CompositeNode} from "../../core/compositeNode";
import {CompileStylesheetNode} from "./compileStylesheetNode";
import {SefTransformNode} from "./sefTransformNode";

interface XsltTransformConfig extends PipelineNodeConfig {
    items?: Input;  // sourceXml files (optional for no-source transforms)
    config: {
        xsltStylesheet: FileRef | Input;
        initialTemplate?: string;
        stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
        serializationParams?: Record<string, any>;
        initialMode?: string;
    };
    outputConfig?: {
        outputFilenameMapping?: (inputPath: string) => string;
        outputDir?: string;
        resultDocumentsDir?: string;
        resultExtension?: string;
    };
}

export class XsltTransformNode extends CompositeNode<XsltTransformConfig, "transformed" | "result-documents"> {
    protected buildInternalNodes(): void {
        const compileName = `${this.name}:compile`;
        const transformName = `${this.name}:transform`;


        const compile = new CompileStylesheetNode({
            name: compileName,
            items: typeof this.config.config.xsltStylesheet === "object" && "path" in this.config.config.xsltStylesheet
                ? this.config.config.xsltStylesheet.path
                : this.config.config.xsltStylesheet,
            config: {},
        })

        const transform = new SefTransformNode({
            name: transformName,
            items: this.items,
            config: {
                sefStylesheet: from(compile, "compiledStylesheet"),
                initialTemplate: this.config.config.initialTemplate,
                stylesheetParams: this.config.config.stylesheetParams,
                serializationParams: this.config.config.serializationParams,
                initialMode: this.config.config.initialMode,
            },
            outputConfig: {
                outputFilenameMapping: this.config.outputConfig?.outputFilenameMapping,
                resultDocumentsDir: this.config.outputConfig?.resultDocumentsDir,
                resultExtension: this.config.outputConfig?.resultExtension,
                outputDir: this.config.outputConfig?.outputDir,

            },
        })

        this.internalNodes = [compile, transform]

        this.outputMappings = {
            "transformed": { node: transform.name, output: "transformed"},
            "result-documents": { node: transform.name, output: "result-documents"},
        }
    }
}
