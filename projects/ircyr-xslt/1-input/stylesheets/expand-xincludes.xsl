<xsl:stylesheet version="2.0"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
                xmlns:xi="http://www.w3.org/2001/XInclude">

    <xsl:template match="@*|node()">
        <xsl:copy>
            <xsl:apply-templates select="@*|node()"/>
        </xsl:copy>
    </xsl:template>

    <xsl:template match="xi:include">
        <xsl:variable name="base" select="base-uri(/)"/>


        <xsl:apply-templates select="doc(resolve-uri(@href, $base))/*"/>
    </xsl:template>

</xsl:stylesheet>