import {XsltTransformNode} from "../../src/xml/nodes/xsltTransformNode";
import {fileRef, Pipeline} from "../../src/core/pipeline";
import {CopyFilesNode} from "../../src/io/copyFilesNode";
import {EleventyBuildNode} from "../../src/eleventy";

const transformEpiDoc = new XsltTransformNode({
    name: "transform-epidoc",
    config: {
        sourceFiles: '1-input/inscriptions/*.xml',
        stylesheet: fileRef("1-input/epidoc-stylesheets/start-edition.xsl"),
        initialTemplate: "inslib-body-structure",
        templateParams: {
            "parm-edition-type": "interpretive",
            "parm-edn-structure": "inslib",
            "parm-external-app-style": "inslib",
            "parm-internal-app-style": "none",
            "parm-leiden-style": "panciera",
            "parm-line-inc": "5",
            "parm-verse-lines": "on",
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/en/inscriptions",
        stripPathPrefix: "1-input/inscriptions",
        extension: ".html"
    }
})

const createEpiDoc11tyFrontmatter = new XsltTransformNode({
    name: "create-epidoc-11ty-frontmatter",
    config: {
        sourceFiles: "1-input/inscriptions/*.xml",
        stylesheet: fileRef("1-input/stylesheets/create-11ty-frontmatter-for-epidoc.xsl")
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/en/inscriptions",
        stripPathPrefix: "1-input/inscriptions",
        extension: ".11tydata.json"
    }
})


const copyEleventySite = new CopyFilesNode({
    name: "copy-eleventy-site",
    config: {
        sourceFiles: "1-input/eleventy-site/**/*"
    },
    outputConfig: {
        outputDir: "2-intermediate",
        stripPathPrefix: "1-input"
    }
})


const eleventyBuild = new EleventyBuildNode({
    name: 'eleventy-build',
    config: {
        sourceDir: './2-intermediate/eleventy-site'
    },
    outputConfig: {
        outputDir: '3-output',
    },
    explicitDependencies: ["transform-epidoc", "copy-eleventy-site", "create-epidoc-11ty-frontmatter"],
});




const pipeline = new Pipeline("IRCyR Eleventy",".efes-build", ".efes-cache", "dynamic");


(async () => {
    await pipeline

        .addNode(transformEpiDoc)
        .addNode(createEpiDoc11tyFrontmatter)
        .addNode(copyEleventySite)
        .addNode(eleventyBuild)

        .run();
})()
