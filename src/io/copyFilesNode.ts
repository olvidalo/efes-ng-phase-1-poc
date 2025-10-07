import {type PipelineNodeConfig, PipelineNode, type PipelineContext, type Input} from "../core/pipeline";
import {copyFile, mkdir, stat, access, constants} from "node:fs/promises";
import path from "node:path";

interface CopyFilesConfig extends PipelineNodeConfig {
    items: Input;
    outputConfig: {
        destinationDir: string;
        base?: string;
        // Default: false
        overwrite?: boolean;
    };
}

export class CopyFilesNode extends PipelineNode<CopyFilesConfig, "copied"> {
    async run(context: PipelineContext) {
        const paths = await context.resolveInput(this.items!);
        const copiedFiles: string[] = [];

        for (const sourcePath of paths) {
            //if this.config.outputConfig.base is set, then we need to resolve the sourcePath (only for destPath)
            const sourcePathWithBase =
                this.config.outputConfig.base
                    ? path.relative(this.config.outputConfig.base, sourcePath)
                    : sourcePath;

            const destPath = path.join(this.config.outputConfig.destinationDir, sourcePathWithBase);

            // Ensure destination directory exists
            await mkdir(path.dirname(destPath), { recursive: true });

            if (!this.config.outputConfig.overwrite) {
                try {
                    await access(destPath, constants.F_OK)
                    context.log(`Skipped: ${sourcePath} → ${destPath}`);
                    continue;
                } catch (error: any) {
                    if (error?.code === 'ENOENT') {
                    } else {
                        throw error;
                    }
                }
            }

            // Copy the file
            if ((await stat(sourcePath)).isFile()) {
                await copyFile(sourcePath, destPath, constants.COPYFILE_FICLONE);
                copiedFiles.push(destPath);
            }

            context.log(`Copied: ${sourcePath} → ${destPath}`);
        }

        return [{ copied: copiedFiles }];
    }
}