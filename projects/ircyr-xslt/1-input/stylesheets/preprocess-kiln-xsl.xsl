<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

    <!--
        Converts cocoon:// URLs to filesystem paths based on Kiln sitemap mappings.

        Parameters:
        - templates-path: Path to compiled templates directory (e.g., "../compiled-templates")

        Mappings from kiln/sitemaps/main.xmap:
        - _internal/template/xsl/** → webapps/ROOT/** (static stylesheets)
        - _internal/template/** → compiled templates (using templates-path parameter)
        - _internal/url/reverse.xsl → dynamically generated (special case)
    -->

    <!-- Path to compiled templates directory -->
    <xsl:param name="templates-path" select="'../compiled-templates'"/>
    <xsl:param name="stylesheet-base-path" required="yes"/>
    <xsl:param name="efes-base-path" required="yes"/>

    <!-- Identity transform -->
    <xsl:template match="@*|node()">
        <xsl:copy>
            <xsl:apply-templates select="@*|node()"/>
        </xsl:copy>
    </xsl:template>


    <xsl:template match="@*">
        <xsl:choose>
            <xsl:when test="contains(., 'system-property')">
                <xsl:attribute name="{name()}" namespace="{namespace-uri()}">
                    <xsl:value-of select="replace(., 'system-property\s*\(\s*([''&quot;])user\.dir\1\s*\)', '''' || $efes-base-path || '''')"/>
                </xsl:attribute>
            </xsl:when>
            <xsl:otherwise>
                <xsl:copy/>
            </xsl:otherwise>
        </xsl:choose>
    </xsl:template>

    <!-- Replace system-property('user.dir') in xsl:value-of text content -->
    <xsl:template match="xsl:value-of/text()">
        <xsl:value-of select="replace(., 'system-property\s*\(\s*([''&quot;])user\.dir\1\s*\)', '''' || $efes-base-path || '''')"/>
    </xsl:template>

    <!-- Resolve cocoon:// imports -->
    <xsl:template match="xsl:import[@href[starts-with(., 'cocoon://')]]">
        <xsl:choose>
            <!-- Map cocoon://_internal/template/xsl/** to filesystem paths -->
            <xsl:when test="starts-with(@href, 'cocoon://_internal/template/xsl/')">
                <xsl:copy>
                    <xsl:attribute name="href">
                        <xsl:value-of select="$stylesheet-base-path"/><xsl:text>/</xsl:text>
                        <xsl:value-of select="substring-after(@href, 'cocoon://_internal/template/xsl/')"/>
                    </xsl:attribute>
                </xsl:copy>
            </xsl:when>

            <!-- Handle cocoon://_internal/url/reverse.xsl (dynamically generated) -->
            <xsl:when test="@href = 'cocoon://_internal/url/reverse.xsl'">
                <xsl:comment>
                    <xsl:text> URL reverse lookup disabled for static generation (was: </xsl:text>
                    <xsl:value-of select="@href"/>
                    <xsl:text>) </xsl:text>
                </xsl:comment>
            </xsl:when>

            <!-- Handle cocoon://_internal/template/** (non-xsl) - map to compiled templates -->
            <xsl:when test="starts-with(@href, 'cocoon://_internal/template/') and not(starts-with(@href, 'cocoon://_internal/template/xsl/'))">
                <xsl:copy>
                    <xsl:attribute name="href">
                        <xsl:value-of select="$templates-path"/>
                        <xsl:text>/</xsl:text>
                        <xsl:value-of select="substring-after(@href, 'cocoon://_internal/template/')"/>
                    </xsl:attribute>
                </xsl:copy>
            </xsl:when>

            <!-- Error on unhandled cocoon:// URLs -->
            <xsl:otherwise>
                <xsl:message terminate="yes">
                    <xsl:text>Unhandled cocoon:// URL in import: </xsl:text>
                    <xsl:value-of select="@href"/>
                    <xsl:text>&#10;Please add a mapping for this URL pattern to preprocess-xsl.xsl</xsl:text>
                </xsl:message>
            </xsl:otherwise>
        </xsl:choose>
    </xsl:template>

</xsl:stylesheet>