<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="3.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:xs="http://www.w3.org/2001/XMLSchema">

    <xsl:output method="xml" indent="no" encoding="UTF-8"/>
    <xsl:mode on-no-match="shallow-skip" />

    <xsl:param name="document_type" as="xs:string?" />

    <!-- Load the Solr schema to determine multiValued fields -->
    <!-- TODO: DON'T HARDCODE -->
    <xsl:variable name="schema" select="document('../ircyr-efes/webapps/solr/conf/schema.xml')"/>

    <!-- Get all field names that are multiValued="true" -->
    <xsl:variable name="multiValued-fields" select="$schema//field[@multiValued='true']/@name"/>

    <xsl:template match="/">
        <response>
            <result>
                <xsl:apply-templates />
            </result>
        </response>
    </xsl:template>

    <!-- Process doc elements and group fields by name -->
    <!-- Matches ALL docs when $document_type is empty/not set -->
    <xsl:template match="doc[not($document_type) or field[@name='document_type'] = $document_type]">
        <xsl:copy>
            <xsl:apply-templates select="@*"/>
            <!-- Group fields by their @name attribute -->
            <xsl:for-each-group select="field[@name]" group-by="@name">
                <xsl:choose>
                    <!-- Check if this field is defined as multiValued in the schema -->
                    <xsl:when test="current-grouping-key() = $multiValued-fields">
                        <arr name="{current-grouping-key()}">
                            <xsl:for-each select="current-group()">
                                <str><xsl:value-of select="."/></str>
                            </xsl:for-each>
                        </arr>
                    </xsl:when>
                    <!-- Single-valued fields: take first occurrence only -->
                    <xsl:otherwise>
                        <str name="{current-grouping-key()}"><xsl:value-of select="current-group()[1]"/></str>
                    </xsl:otherwise>
                </xsl:choose>
            </xsl:for-each-group>
        </xsl:copy>
    </xsl:template>

</xsl:stylesheet>