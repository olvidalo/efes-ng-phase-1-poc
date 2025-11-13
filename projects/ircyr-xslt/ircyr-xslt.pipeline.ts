import {CopyFilesNode} from "../../src/io/copyFilesNode";
import {fileRef, from, Pipeline} from "../../src/core/pipeline";
import path from "node:path";
import {XsltTransformNode} from "../../src/xml/nodes/xsltTransformNode";



// ----- PREPARE KILN XSLs AND TEMPLATES -----

// Copy all Kiln / Efes files to the preprocessed directory so relative imports in XSLs work
const copyKiln = new CopyFilesNode({
    name: "copy-kiln",
    config: {
        sourceFiles: "1-input/ircyr-efes/**/*"
    },
    outputConfig: {
        outputDir: "2-intermediate",
        stripPathPrefix: "1-input"
    }
})

const preprocessKilnXsl = new XsltTransformNode({
    name: "kiln-xsl-preprocess",
    config: {
        sourceFiles: from(copyKiln, "copied", "2-intermediate/ircyr-efes/webapps/ROOT/**/*.xsl"),
        stylesheet: fileRef("1-input/stylesheets/preprocess-kiln-xsl.xsl"),
        stylesheetParams: {
            "stylesheet-base-path": path.resolve("2-intermediate/ircyr-efes/webapps/ROOT"),
            "efes-base-path": path.resolve("1-input/ircyr-efes"),
        }
    },
    outputConfig: {
        outputDir: "2-intermediate",
        stripPathPrefix: "2-intermediate",
        extension: ".xsl"
    }
})

const preprocessKilnTemplates = new XsltTransformNode({
    name: "templates-preprocess",
    config: {
        sourceFiles: from(copyKiln, "copied", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/**/*.xml"),
        stylesheet: fileRef("1-input/stylesheets/preprocess-kiln-xsl.xsl"),
        stylesheetParams: {
            "stylesheet-base-path": path.resolve("2-intermediate/ircyr-efes/webapps/ROOT"),
            "efes-base-path": path.resolve("1-input/ircyr-efes")
        }
    },
    outputConfig: {
        outputDir: "2-intermediate",
        stripPathPrefix: "2-intermediate",
    }
})

const templatesExpandXIncludes = new XsltTransformNode({
    name: "templates-expand-xincludes",
    config: {
        sourceFiles: from(preprocessKilnTemplates, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/{epidoc-inslib,inscription-index,home}.xml"),
        stylesheet: fileRef("1-input/stylesheets/expand-xincludes.xsl")
    }
})

const templatesInherit = new XsltTransformNode({
    name: "template-inherit-template",
    config: {
        sourceFiles: from(templatesExpandXIncludes, "transformed"),
        stylesheet: from(preprocessKilnXsl, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/kiln/stylesheets/template/inherit-template.xsl")
    },
    outputConfig: {
        extension: '.xsl'
    }
})


// ----- CREATE INSCRIPTION PAGES -----

const epidocMenuAggregation = new XsltTransformNode({
    name: "epidoc-menu-aggregation",
    config: {
        sourceFiles: "1-input/ircyr-efes/webapps/ROOT/content/xml/epidoc/*.xml",
        stylesheet: fileRef("1-input/stylesheets/create-menu-aggregation.xsl"),
        stylesheetParams: {
            url: (inputPath: string) => {
                const inputFilename = path.basename(inputPath);
                const inputBasename = path.basename(inputFilename, path.extname(inputFilename));
                return path.join( "/en/inscriptions", inputBasename + '.html');
            },
            language: "en"
        }
    },
    explicitDependencies: ["copy-kiln", "kiln-xsl-preprocess", "templates-preprocess"]
})

const epidocTransform = new XsltTransformNode({
    name: `transform-epidoc`,
    config: {
        sourceFiles: from(epidocMenuAggregation, "transformed"),
        stylesheet: from(templatesInherit, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/epidoc-inslib.xsl"),
        stylesheetParams: {
            "language": "en"
        },
        serializationParams: {
            "method": "html",
            "indent": true
        }
    },
    outputConfig: {
        outputDir: "3-output/en/inscriptions",
        flattenToBasename: true,
        extension: ".html"
    }
})


// ----- CREATE INSCRIPTION INDEX -----

const transformEpiDocToSolr = new XsltTransformNode({
    name: 'epidoc-to-solr',
    config: {
        sourceFiles: "1-input/ircyr-efes/webapps/ROOT/content/xml/epidoc/*.xml",
        stylesheet: from(preprocessKilnXsl, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/stylesheets/solr/tei-to-solr.xsl"),
        stylesheetParams: {
            'file-path': function (inputPath: string) {
                const relativePath = inputPath.replace("1-input/ircyr-efes/webapps/ROOT/content/xml/", "")
                return relativePath.replace(".xml", "")
            }
        }
    }
})

const aggregateSolrDocs = new XsltTransformNode({
    name: 'epidoc-aggregate-solr-docs',
    config: {
        stylesheet: fileRef('1-input/stylesheets/aggregate-epidoc-solr-docs.xsl'),
        initialTemplate: 'main',
        stylesheetParams: {
            'documents': from(transformEpiDocToSolr, "transformed")
        }
    }
})

const solrDocsToResults = new XsltTransformNode({
    name: "epidoc-solr-docs-to-results",
    config: {
        sourceFiles: from(aggregateSolrDocs, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/solr-docs-to-results.xsl"),
        stylesheetParams: {
            "document_type": "epidoc"
        }
    }
})

const createInscriptionListMenuAggregation = new XsltTransformNode({
    name: "epidoc-inscription-list-menu-aggregation",
    config: {
        sourceFiles: from(solrDocsToResults, "transformed"),
        stylesheet: fileRef("1-input/stylesheets/create-menu-aggregation.xsl"),
        stylesheetParams: {
            url: "/en/inscriptions/index.html",
            language: "en"
        }
    },
    explicitDependencies: ["copy-kiln", "kiln-xsl-preprocess", "templates-preprocess"]
})

const createInscriptionList = new XsltTransformNode({
    name: "epidoc-create-inscription-list",
    config: {
        sourceFiles: from(createInscriptionListMenuAggregation, "transformed"),
        stylesheet: from(templatesInherit, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/inscription-index.xsl"),
        stylesheetParams: {
            "language": "en"
        }
    },
    outputConfig: {
        outputDir: "3-output",
        outputFilename: "en/inscriptions/index.html"
    }
})


// ----- CREATE HOME PAGE -----

const homeMenuAggregation = new XsltTransformNode({
    name: "home-menu-aggregation",
    config: {
        sourceFiles: from(preprocessKilnTemplates, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/home.xml"),
        stylesheet: fileRef("1-input/stylesheets/create-menu-aggregation.xsl"),
        stylesheetParams: {
            url: "/en",
            language: "en"
        }
    },
    explicitDependencies: ["copy-kiln", "kiln-xsl-preprocess", "templates-preprocess"]
})

const transformHome = new XsltTransformNode({
    name: `transform-home`,
    config: {
        sourceFiles: from(homeMenuAggregation, "transformed"),
        stylesheet: from(templatesInherit, "transformed", "2-intermediate/ircyr-efes/webapps/ROOT/assets/templates/home.xsl")
    },
    outputConfig: {
        outputDir: "3-output",
        outputFilename: "en/index.html"
    }
})


const copyKilnAssets = new CopyFilesNode({
    name: "copy-assets",
    config: {
        sourceFiles: "1-input/ircyr-efes/webapps/ROOT/assets/{foundation,styles,images,scripts}/**/*"
    },
    outputConfig: {
        outputDir: "3-output",
        stripPathPrefix: "1-input/ircyr-efes/webapps/ROOT"
    }
});


const pipeline = new Pipeline("IRCyR XSLT",".efes-build", ".efes-cache", "dynamic");

(async () => {
    await pipeline
        .addNode(copyKiln)
        .addNode(preprocessKilnXsl)
        .addNode(preprocessKilnTemplates)
        .addNode(templatesExpandXIncludes)
        .addNode(templatesInherit)

        .addNode(epidocMenuAggregation)
        .addNode(epidocTransform)

        .addNode(transformEpiDocToSolr)
        .addNode(aggregateSolrDocs)
        .addNode(solrDocsToResults)
        .addNode(createInscriptionListMenuAggregation)
        .addNode(createInscriptionList)

        .addNode(homeMenuAggregation)
        .addNode(transformHome)

        .addNode(copyKilnAssets)

        .run();
})()
