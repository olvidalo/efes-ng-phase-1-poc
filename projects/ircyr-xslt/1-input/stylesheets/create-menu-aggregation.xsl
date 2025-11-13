<xsl:stylesheet version="3.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
>

    <xsl:param name="url" required="yes" />
    <xsl:param name="language" required="yes" />

    <!-- TODO: Don't hardcode paths -->
    <xsl:variable name="menuXml" select="document('../ircyr-efes/webapps/ROOT/assets/menu/main.xml')"/>
    <xsl:variable name="normaliseMenuStylesheet" select="document('../../2-intermediate/ircyr-efes/webapps/ROOT/kiln/stylesheets/menu/normalise-menu.xsl')"/>
    <xsl:variable name="contextualiseMenuStylesheet" select="document('../../2-intermediate/ircyr-efes/webapps/ROOT/kiln/stylesheets/menu/contextualise-menu.xsl')"/>

    <xsl:variable name="normalisedMenuXml" select="transform(map {
                'stylesheet-node': $normaliseMenuStylesheet,
                'source-node': $menuXml,
                'stylesheet-params': map { QName('', 'url'): $url, QName('', 'language'): $language }
            })?output"/>

    <xsl:variable name="contextualisedMenuXml" select="transform(map {
                'stylesheet-node': $contextualiseMenuStylesheet,
                'source-node': $normalisedMenuXml,
                'stylesheet-params': map { QName('', 'url'): $url, QName('', 'language'): $language }
            })?output"/>

    <xsl:template match="/" name="main">
        <aggregation>
            <xsl:copy-of select="$contextualisedMenuXml" />
            <xsl:apply-templates/>
        </aggregation>
    </xsl:template>

    <xsl:template match="@*|node()">
        <xsl:copy>
            <xsl:apply-templates select="@*|node()"/>
        </xsl:copy>
    </xsl:template>

</xsl:stylesheet>