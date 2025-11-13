import {from, type Input, type PipelineNodeConfig, type FileRef, type UnifiedOutputConfig} from "../../core/pipeline";
import {CompositeNode} from "../../core/compositeNode";
import {CompileStylesheetNode} from "./compileStylesheetNode";
import {SefTransformNode} from "./sefTransformNode";

interface XsltTransformConfig extends PipelineNodeConfig {
    config: {
        sourceFiles?: Input;  // sourceXml files (optional for no-source transforms)
        stylesheet: FileRef | Input;
        initialTemplate?: string;
        stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
        tunnelParams?: Record<string, any | ((inputPath: string) => any)>;
        templateParams?: Record<string, any | ((inputPath: string) => any)>;
        serializationParams?: Record<string, any>;
        initialMode?: string;
    };
    outputConfig?: UnifiedOutputConfig;
}

export class XsltTransformNode extends CompositeNode<XsltTransformConfig, "transformed" | "result-documents" | "compiledStylesheet"> {
    protected buildInternalNodes(): void {
        const compileName = `${this.name}:compile`;
        const transformName = `${this.name}:transform`;


        const compile = new CompileStylesheetNode({
            name: compileName,
            config: {
                stylesheets: typeof this.config.config.stylesheet === "object" && "path" in this.config.config.stylesheet
                    ? this.config.config.stylesheet.path
                    : this.config.config.stylesheet,
            },
        })

        const transform = new SefTransformNode({
            name: transformName,
            config: {
                sourceFiles: this.config.config.sourceFiles,
                sefStylesheet: from(compile, "compiledStylesheet"),
                initialTemplate: this.config.config.initialTemplate,
                stylesheetParams: this.config.config.stylesheetParams,
                templateParams: this.config.config.templateParams,
                serializationParams: this.config.config.serializationParams,
                initialMode: this.config.config.initialMode,
            },
            outputConfig: this.config.outputConfig,
        })

        this.internalNodes = [compile, transform]

        this.outputMappings = {
            "transformed": { node: transform.name, output: "transformed"},
            "result-documents": { node: transform.name, output: "result-documents"},
            "compiledStylesheet": { node: compile.name, output: "compiledStylesheet"},
        }
    }
}
