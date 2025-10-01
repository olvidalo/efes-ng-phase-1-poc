import {from, type Input, type PipelineNodeConfig} from "../../core/pipeline";
import {CompositeNode} from "../../core/compositeNode";
import {CompileStylesheetNode} from "./compileStylesheetNode";
import {SefTransformNode} from "./sefTransformNode";

interface XsltTransformConfig extends PipelineNodeConfig {
    inputs: {
        xsltStylesheet: Input;
        sourceXml?: Input;
    };
    outputFilenameMapping?: (inputPath: string) => string;
    resultDocumentsDir?: string;
    initialTemplate?: string;
    stylesheetParams?: Record<string, any | ((inputPath: string) => any)>;
    initialMode?: string;
}

export class XsltTransformNode extends CompositeNode<XsltTransformConfig, "transformed" | "result-documents"> {
    protected buildInternalNodes(): void {
        const compile = new CompileStylesheetNode({
            name: `${this.name}:compile`,
            inputs: { xslt: this.config.inputs.xsltStylesheet },
        })

        const transform = new SefTransformNode({
            name: `${this.name}:transform`,
            inputs: {
                sefStylesheet: from(compile, "compiledStylesheet"),
                sourceXml: this.config.inputs.sourceXml,
            },
            outputFilenameMapping: this.config.outputFilenameMapping,
            resultDocumentsDir: this.config.resultDocumentsDir,
            initialTemplate: this.config.initialTemplate,
            stylesheetParams: this.config.stylesheetParams,
            initialMode: this.config.initialMode,
        })

        this.internalNodes = [compile, transform]

        this.outputMappings = {
            "transformed": { node: transform.name, output: "transformed"},
            "result-documents": { node: transform.name, output: "result-documents"},
        }
    }
}
