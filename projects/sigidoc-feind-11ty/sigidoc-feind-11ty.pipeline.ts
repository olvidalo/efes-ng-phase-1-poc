import {XsltTransformNode} from "../../src/xml/nodes/xsltTransformNode";
import {fileRef, from, Pipeline} from "../../src/core/pipeline";
import {CopyFilesNode} from "../../src/io/copyFilesNode";
import {EleventyBuildNode} from "../../src/eleventy";


// English

const pruneEpidocEnglish = new XsltTransformNode({
    name: "prune-epidoc-english",
    config: {
        sourceFiles: '1-input/feind-collection/*.xml',
        stylesheet: fileRef("1-input/stylesheets/prune-to-language.xsl"),
        stylesheetParams: {
            language: 'en',
        }
    }
})

const transformEpiDocEnglish = new XsltTransformNode({
    name: "transform-epidoc-en",
    config: {
        sourceFiles: from(pruneEpidocEnglish, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/epidoc-to-html.xsl"),
        stylesheetParams: {
            language: 'en',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/en/seals",
        stripPathPrefix: "1-input/feind-collection",
        extension: ".html"
    }
})

const createEpiDoc11tyFrontmatterEnglish = new XsltTransformNode({
    name: "create-epidoc-11ty-frontmatter-en",
    config: {
        sourceFiles: from(pruneEpidocEnglish, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/create-11ty-frontmatter-for-sigidoc.xsl"),
        stylesheetParams: {
            language: 'en',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/en/seals",
        stripPathPrefix: "1-input/feind-collection",
        extension: ".11tydata.json"
    }
})


// German

const pruneEpidocGerman = new XsltTransformNode({
    name: "prune-epidoc-german",
    config: {
        sourceFiles: '1-input/feind-collection/*.xml',
        stylesheet: fileRef("1-input/stylesheets/prune-to-language.xsl"),
        stylesheetParams: {
            language: 'de',
        }
    }
})

const transformEpiDocGerman = new XsltTransformNode({
    name: "transform-epidoc-de",
    config: {
        sourceFiles: from(pruneEpidocGerman, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/epidoc-to-html.xsl"),
        stylesheetParams: {
            language: 'de',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/de/seals",
        stripPathPrefix: "1-input/feind-collection",
        extension: ".html"
    }
})

const createEpiDoc11tyFrontmatterGerman = new XsltTransformNode({
    name: "create-epidoc-11ty-frontmatter-de",
    config: {
        sourceFiles: from(pruneEpidocGerman, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/create-11ty-frontmatter-for-sigidoc.xsl"),
        stylesheetParams: {
            language: 'de',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/de/seals",
        stripPathPrefix: "1-input/feind-collection",
        extension: ".11tydata.json"
    }
})


// Greek

const pruneEpidocGreek = new XsltTransformNode({
    name: "prune-epidoc-greek",
    config: {
        sourceFiles: '1-input/feind-collection/*.xml',
        stylesheet: fileRef("1-input/stylesheets/prune-to-language.xsl"),
        stylesheetParams: {
            language: 'el',
        }
    }
})

const transformEpiDocGreek = new XsltTransformNode({
    name: "transform-epidoc-el",
    config: {
        sourceFiles: from(pruneEpidocGreek, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/epidoc-to-html.xsl"),
        stylesheetParams: {
            language: 'el',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/el/seals",
        stripPathPrefix: "1-input/feind-collection",
        extension: ".html"
    }
})

const createEpiDoc11tyFrontmatterGreek = new XsltTransformNode({
    name: "create-epidoc-11ty-frontmatter-el",
    config: {
        sourceFiles: from(pruneEpidocGerman, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/create-11ty-frontmatter-for-sigidoc.xsl"),
        stylesheetParams: {
            language: 'el',
        }
    },
    outputConfig: {
        outputDir: "2-intermediate/eleventy-site/el/seals",
        stripPathPrefix: "1-input/feind-collection",
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
    explicitDependencies: [
        "transform-epidoc-en",
        "create-epidoc-11ty-frontmatter-en",
        "transform-epidoc-de",
        "create-epidoc-11ty-frontmatter-de",
        "transform-epidoc-el",
        "create-epidoc-11ty-frontmatter-el",
        "copy-eleventy-site"
    ],
});




const pipeline = new Pipeline("IRCyR Eleventy",".efes-build", ".efes-cache", "dynamic");


(async () => {
    await pipeline

        .addNode(pruneEpidocEnglish)
        .addNode(transformEpiDocEnglish)
        .addNode(createEpiDoc11tyFrontmatterEnglish)

        .addNode(pruneEpidocGerman)
        .addNode(transformEpiDocGerman)
        .addNode(createEpiDoc11tyFrontmatterGerman)

        .addNode(pruneEpidocGreek)
        .addNode(transformEpiDocGreek)
        .addNode(createEpiDoc11tyFrontmatterGreek)

        .addNode(copyEleventySite)
        .addNode(eleventyBuild)

        .run();
})()
