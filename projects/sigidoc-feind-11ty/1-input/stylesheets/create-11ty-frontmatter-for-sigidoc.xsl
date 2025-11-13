<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:tei="http://www.tei-c.org/ns/1.0"
    xmlns:fn="http://www.w3.org/2005/xpath-functions"
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    exclude-result-prefixes="tei fn xs">

    <!-- TODO: de-duplicate with texts frontmatter stylesheet using param, import or similar -->

    <xsl:output method="text" encoding="UTF-8"/>

    <!-- Parameter for the source file path (to extract filename) -->
    <xsl:param name="source-file" select="base-uri()"/>
    <xsl:param name="language" select="en"/>

    <!-- Extract filename without extension -->
    <xsl:variable name="filename">
        <xsl:variable name="full-name" select="tokenize($source-file, '/')[last()]"/>
        <xsl:value-of select="substring-before($full-name, '.xml')"/>
    </xsl:variable>

    <!-- Extract title from TEI header -->
    <xsl:variable name="title">
        <xsl:variable name="tei-title" select="//*:titleStmt/*:title[1]/normalize-space(.)"/>
        <xsl:choose>
            <xsl:when test="string-length($tei-title) > 0">
                <xsl:value-of select="$tei-title"/>
            </xsl:when>
            <xsl:otherwise>
                <xsl:value-of select="$filename"/>
            </xsl:otherwise>
        </xsl:choose>
    </xsl:variable>

    <!-- Generate sortKey for natural sorting (A.1, A.2, ..., A.9, A.10, A.11...) -->
    <xsl:variable name="sortKey">
        <xsl:variable name="parts" select="tokenize($filename, '\.')"/>
        <xsl:for-each select="$parts">
            <xsl:choose>
                <!-- If part is numeric, pad with zeros to 5 digits -->
                <xsl:when test=". castable as xs:integer">
                    <xsl:value-of select="format-number(xs:integer(.), '00000')"/>
                </xsl:when>
                <!-- Otherwise keep as-is -->
                <xsl:otherwise>
                    <xsl:value-of select="."/>
                </xsl:otherwise>
            </xsl:choose>
            <!-- Add dot separator except after last part -->
            <xsl:if test="position() != last()">
                <xsl:text>.</xsl:text>
            </xsl:if>
        </xsl:for-each>
    </xsl:variable>

    <!-- Main template - create JSON structure -->
    <xsl:template match="/">
        <!-- Create map and serialize to JSON -->
        <xsl:sequence select="fn:serialize(
            map{
                'layout': 'layouts/document.njk',
                'language': $language,
                'title': $title,
                'date': current-dateTime(),
                'documentId': $filename,
                'sourceFile': concat($filename, '.xml'),
                'permalink': concat($language, '/seals/', $filename, '.html'),
                'tags': 'seals',
                'sortKey': $sortKey,
                'findspot': string-join(//tei:placeName[@type='ancientFindspot'], ', '),
                'origDate': string-join(//tei:origDate, ', ')
            },
            map{'method': 'json', 'indent': true()}
        )"/>
    </xsl:template>

</xsl:stylesheet>