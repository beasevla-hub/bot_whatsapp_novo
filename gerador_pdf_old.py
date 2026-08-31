#!/usr/bin/env python3
import sys
import json
import re
import unicodedata
from datetime import datetime, date
from collections import defaultdict


try:
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib import colors
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.units import mm
except ImportError:
    print('ERRO: reportlab não está instalado. Execute: pip install reportlab')
    sys.exit(1)


ORGAOS_HARDCODED = {
    'secretaria municipal de esportes e lazer': 'SEME',
    'secretaria de esportes e lazer': 'SEME',
    'esportes e lazer': 'SEME',
    'seme': 'SEME',
    'secretaria municipal de infraestrutura urbana': 'SIURB',
    'secretaria de infraestrutura urbana': 'SIURB',
    'infraestrutura urbana': 'SIURB',
    'siurb': 'SIURB',
    'secretaria municipal das subprefeituras': 'SMSUB',
    'secretaria das subprefeituras': 'SMSUB',
    'smsub': 'SMSUB',
    'smsub cogel': 'SMSUB',
    'smsub - cogel': 'SMSUB',
    'spobras': 'São Paulo Obras',
    'sp obras': 'São Paulo Obras',
    'sao paulo obras': 'São Paulo Obras',
    'são paulo obras': 'São Paulo Obras'
}


def limpar_texto(texto):
    if not texto:
        return 'Não informado'
    texto = re.sub(r'^[^\w\s]+', '', str(texto))
    texto = re.sub(r'[^\w\sà-úÀ-Ú.,\-()\\/]', '', texto)
    texto = re.sub(r'\s+', ' ', texto)
    return texto.strip() or 'Não informado'


def normalizar_texto(texto):
    texto = str(texto or '').strip().lower()
    texto = ''.join(c for c in unicodedata.normalize('NFD', texto) if unicodedata.category(c) != 'Mn')
    texto = re.sub(r'[^a-z0-9\s/\-]', ' ', texto)
    return re.sub(r'\s+', ' ', texto).strip()


def padronizar_orgao_relatorio(orgao):
    bruto = limpar_texto(orgao)
    norm = normalizar_texto(bruto)
    for alias, nome in ORGAOS_HARDCODED.items():
        alias_norm = normalizar_texto(alias)
        if norm == alias_norm or alias_norm in norm or norm in alias_norm:
            return nome
    return bruto


def ordem_orgao(orgao):
    nome_norm = normalizar_texto(orgao)
    if nome_norm.startswith('subprefeitura '):
        return (0, nome_norm)
    if nome_norm == 'seme':
        return (1, nome_norm)
    if nome_norm == 'siurb':
        return (2, nome_norm)
    if nome_norm == 'smsub':
        return (3, nome_norm)
    return (4, nome_norm)


def converter_valor(valor_text):
    if not valor_text:
        return 0.0
    numeros = re.findall(r'\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?', str(valor_text))
    if not numeros:
        try:
            return float(str(valor_text).replace(',', '.'))
        except ValueError:
            return 0.0
    valor_limpo = numeros[0].replace('.', '').replace(',', '.')
    try:
        return float(valor_limpo)
    except ValueError:
        return 0.0


def formatar_valor(valor_num):
    return f'R$ {valor_num:,.2f}'.replace('.', '_').replace(',', '.').replace('_', ',')


def get_cor_status(status):
    if status == 'SIM':
        return colors.Color(0.2, 0.7, 0.2)
    if status == 'SIMILARIDADE':
        return colors.Color(1.0, 0.7, 0.2)
    if status == 'NÃO APTA':
        return colors.Color(0.9, 0.3, 0.3)
    return colors.black


def processar_aptos(thi_atestados, phas_atestados):
    thi = str(thi_atestados or '').upper()
    phas = str(phas_atestados or '').upper()
    
    # 1. se tiver "A DEFINIR" em algum lado
    if 'DEFINIR' in thi or 'DEFINIR' in phas:
        return 'A DEFINIR'

    # 2. ajusta flags considerando o "NÃO APTA" antes do "APTA"
    thi_is_nao_apta = 'NÃO APTA' in thi or 'NAO APTA' in thi
    phas_is_nao_apta = 'NÃO APTA' in phas or 'NAO APTA' in phas

    thi_is_apta = 'APTA' in thi and not thi_is_nao_apta
    phas_is_apta = 'APTA' in phas and not phas_is_nao_apta

    thi_has_similar = 'SIMILARIDADE' in thi
    phas_has_similar = 'SIMILARIDADE' in phas

    # 3. regras de retorno
    if thi_is_apta and phas_is_apta:
        return 'SIM'
    
    if (thi_is_apta and phas_has_similar) or (phas_is_apta and thi_has_similar):
        return 'SIMILARIDADE'
        
    if thi_has_similar or phas_has_similar:
        return 'SIMILARIDADE'

    return 'NÃO APTA'


def parse_date_iso(valor):
    if not valor:
        return None
    txt = str(valor).strip()
    for tentativa in (
        lambda v: datetime.fromisoformat(v.replace('Z', '+00:00')).date(),
        lambda v: datetime.strptime(v[:10], '%Y-%m-%d').date(),
        lambda v: datetime.strptime(v[:10], '%d/%m/%Y').date(),
    ):
        try:
            return tentativa(txt)
        except Exception:
            pass
    return None


def formatar_data_br(valor):
    data = parse_date_iso(valor)
    if not data:
        return 'N/A'
    return data.strftime('%d/%m/%Y')


def get_rich_text(props, field_name):
    field_data = props.get(field_name, {})
    rich_text = field_data.get('rich_text', [])
    if rich_text:
        return rich_text[0].get('plain_text', '')
    title = field_data.get('title', [])
    if title:
        return title[0].get('plain_text', '')
    return ''


def get_date_raw(props, field_name):
    field_data = props.get(field_name, {})
    date_info = field_data.get('date', {})
    return date_info.get('start', '') if date_info.get('start') else ''


def extrair_orgao(props):
    candidatos = [
        get_rich_text(props, 'ÓRGÃO/CLIENTE'),
        get_rich_text(props, 'CLIENTE'),
        get_rich_text(props, 'ÓRGÃO'),
        get_rich_text(props, 'ORGAO'),
        get_rich_text(props, 'SUBPREFEITURA'),
    ]
    for valor in candidatos:
        valor = limpar_texto(valor)
        if valor and valor != 'Não informado':
            return padronizar_orgao_relatorio(valor)
    return 'Órgão não informado'


# ─────────────────────────────────────────────────────────────
# MODO DETALHADO (sem alterações)
# ─────────────────────────────────────────────────────────────

def gerar_pdf_detalhado(payload, local_busca, arquivo_saida):
    dados_licitacoes = payload.get('licitacoes', []) if isinstance(payload, dict) else payload
    data_inicio = payload.get('data_inicio') if isinstance(payload, dict) else None
    data_fim = payload.get('data_fim') if isinstance(payload, dict) else None
    ocultar_aptos = bool(payload.get('ocultar_aptos', False)) if isinstance(payload, dict) else False

    hoje = date.today()
    doc = SimpleDocTemplate(arquivo_saida, pagesize=landscape(A4), rightMargin=20, leftMargin=20, topMargin=30, bottomMargin=30)
    styles = getSampleStyleSheet()
    normal_style = styles['Normal']
    normal_style.fontName = 'Helvetica'
    normal_style.fontSize = 9
    elements = []

    header_style = ParagraphStyle('HeaderSlim', parent=styles['Normal'], fontSize=9, fontName='Helvetica', textColor=colors.Color(0.4, 0.4, 0.4), alignment=1, spaceAfter=10)
    periodo_txt = ''
    if data_inicio and data_fim:
        periodo_txt = f' | Período: {formatar_data_br(data_inicio)} a {formatar_data_br(data_fim)}'
    header_text = f'Local: {local_busca}{periodo_txt} | Gerado: {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}'
    elements.append(Paragraph(header_text, header_style))

    total_geral = 0.0
    headers = ['EDITAL', 'ÓRGÃO', 'OBJETO', 'VALOR', 'DATA'] if ocultar_aptos else ['EDITAL', 'ÓRGÃO', 'OBJETO', 'VALOR', 'DATA', 'APTOS?']
    table_data = [headers]
    linhas_passadas = []
    row_colors = []

    for licitacao in dados_licitacoes:
        props = licitacao.get('properties', {})
        edital = limpar_texto(get_rich_text(props, 'N DO EDITAL') or 'N/A')
        orgao = extrair_orgao(props)
        objeto = limpar_texto(get_rich_text(props, 'OBJETO') or 'N/A')
        valor_text = limpar_texto(get_rich_text(props, 'VALOR DA OBRA') or '0')
        data_raw = get_date_raw(props, 'DATA E HORA')
        data_br = formatar_data_br(data_raw)
        valor_num = converter_valor(valor_text)
        valor_formatado = formatar_valor(valor_num)
        total_geral += valor_num

        thi_atestados = get_rich_text(props, '(THI) ATESTADOS')
        phas_atestados = get_rich_text(props, '(PHAS) ATESTADOS')
        aptos = processar_aptos(thi_atestados, phas_atestados)
        row_colors.append(get_cor_status(aptos))

        data_licitacao = parse_date_iso(data_raw)
        linha_atual = len(table_data)
        if data_licitacao and data_licitacao < hoje:
            linhas_passadas.append(linha_atual)

        linha = [edital, Paragraph(orgao, normal_style), Paragraph(objeto, normal_style), valor_formatado, data_br]
        if not ocultar_aptos:
            linha.append(aptos)
        table_data.append(linha)

    page_width = 842 - 40
    col_widths = [page_width * 0.10, page_width * 0.18, page_width * 0.32, page_width * 0.15, page_width * 0.12, page_width * 0.13]
    if ocultar_aptos:
        col_widths = [page_width * 0.12, page_width * 0.20, page_width * 0.34, page_width * 0.14, page_width * 0.10]

    table = Table(table_data, colWidths=col_widths, repeatRows=1)
    table_style = TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0, 0.2, 0.4)),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTSIZE', (0, 0), (-1, 0), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 5),
        ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ('TOPPADDING', (0, 0), (-1, -1), 8),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 8),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('ALIGN', (0, 1), (0, -1), 'LEFT'),
        ('ALIGN', (3, 1), (3, -1), 'RIGHT'),
        ('ALIGN', (4, 1), (4, -1), 'CENTER'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -1), 9),
        ('GRID', (0, 0), (-1, -1), 0.5, colors.Color(0.7, 0.7, 0.7)),
        ('LINEBELOW', (0, 0), (-1, 0), 1.5, colors.Color(0, 0.2, 0.4)),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.Color(0.98, 0.98, 0.98)])
    ])

    if not ocultar_aptos:
        table_style.add('ALIGN', (5, 1), (5, -1), 'CENTER')
        for i, cor in enumerate(row_colors, start=1):
            if cor != colors.black:
                table_style.add('TEXTCOLOR', (5, i), (5, i), cor)

    for row_idx in linhas_passadas:
        table_style.add('BACKGROUND', (0, row_idx), (-1, row_idx), colors.Color(1.0, 0.96, 0.65))

    table.setStyle(table_style)
    elements.append(table)
    elements.append(Spacer(1, 20))

    if linhas_passadas:
        legenda = Paragraph('Linhas destacadas em amarelo indicam licitações com data anterior à data atual.', ParagraphStyle('Legenda', parent=styles['Normal'], fontSize=8, textColor=colors.Color(0.35, 0.35, 0.35), alignment=0, spaceAfter=12))
        elements.append(legenda)

    total_style = ParagraphStyle('TotalStyle', parent=normal_style, fontSize=16, fontName='Helvetica-Bold', textColor=colors.Color(0, 0.4, 0), alignment=2, backColor=colors.Color(0.95, 0.98, 0.95), borderWidth=2, borderColor=colors.Color(0, 0.4, 0), borderRadius=8, padding=25, spaceBefore=30, spaceAfter=10, leftIndent=40, rightIndent=40, leading=20)
    elements.append(Spacer(1, 20))
    elements.append(Paragraph(f'TOTAL GERAL: {formatar_valor(total_geral)}', total_style))

    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.setFillColorRGB(0.5, 0.5, 0.5)
        canvas.drawCentredString(doc.pagesize[0] / 2, 20, f'Página {doc.page} • Gerado em {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}')
        canvas.restoreState()

    doc.build(elements, onFirstPage=on_page, onLaterPages=on_page)


# ─────────────────────────────────────────────────────────────
# MODO GERAL HIERÁRQUICO (novo)
# ─────────────────────────────────────────────────────────────

def _construir_bloco_orgao(orgao_nome, licitacoes_orgao, styles, hoje):
    """
    Retorna uma lista de flowables (elements) para um bloco de órgão:
    - Cabeçalho resumo (1 linha azul)
    - Sub-tabela com os editais
    """
    elements = []

    # ── Estilos ──────────────────────────────────────────────
    cell_style = ParagraphStyle(
        'CellGeral',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=8,
        leading=11,
        wordWrap='CJK'
    )

    # ── Calcular resumo do órgão ─────────────────────────────
    total_orgao = sum(converter_valor(get_rich_text(l.get('properties', {}), 'VALOR DA OBRA') or '0') for l in licitacoes_orgao)
    datas = []
    for l in licitacoes_orgao:
        d = parse_date_iso(get_date_raw(l.get('properties', {}), 'DATA E HORA'))
        if d:
            datas.append(d)
    datas.sort()
    periodo = f'{datas[0].strftime("%d/%m/%Y")} a {datas[-1].strftime("%d/%m/%Y")}' if datas else 'N/A'

    # ── Linha de cabeçalho do órgão ─────────────────────────
    page_width = 595 - 40  # A4 retrato - margens
    header_row = [[
        Paragraph(f'<b>{orgao_nome}</b>', ParagraphStyle('OrgHeader', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, leading=12)),
        Paragraph(f'<b>{len(licitacoes_orgao)} licitaç{"ão" if len(licitacoes_orgao) == 1 else "ões"}</b>', ParagraphStyle('OrgHeaderC', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, alignment=1, leading=12)),
        Paragraph(f'<b>{formatar_valor(total_orgao)}</b>', ParagraphStyle('OrgHeaderR', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, alignment=2, leading=12)),
        Paragraph(f'<b>{periodo}</b>', ParagraphStyle('OrgHeaderP', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=9, textColor=colors.white, alignment=1, leading=12)),
    ]]
    header_col_widths = [page_width * 0.42, page_width * 0.12, page_width * 0.24, page_width * 0.22]
    header_table = Table(header_row, colWidths=header_col_widths)
    header_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0, 0.2, 0.4)),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LINEBELOW', (0, 0), (-1, 0), 1.5, colors.Color(0, 0.35, 0.65)),
    ]))
    elements.append(header_table)

    # ── Sub-cabeçalho das colunas dos editais ────────────────
    sub_headers = ['EDITAL', 'OBJETO', 'VALOR', 'DATA']
    sub_col_widths = [page_width * 0.18, page_width * 0.50, page_width * 0.18, page_width * 0.14]

    sub_header_style = ParagraphStyle('SubH', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=8, textColor=colors.white)
    sub_data = [[Paragraph(h, sub_header_style) for h in sub_headers]]

    linhas_passadas = []

    for licitacao in licitacoes_orgao:
        props = licitacao.get('properties', {})
        edital = limpar_texto(get_rich_text(props, 'N DO EDITAL') or 'N/A')
        objeto = limpar_texto(get_rich_text(props, 'OBJETO') or 'N/A')
        valor_num = converter_valor(get_rich_text(props, 'VALOR DA OBRA') or '0')
        data_raw = get_date_raw(props, 'DATA E HORA')
        data_br = formatar_data_br(data_raw)
        data_licitacao = parse_date_iso(data_raw)

        linha_idx = len(sub_data)
        if data_licitacao and data_licitacao < hoje:
            linhas_passadas.append(linha_idx)

        sub_data.append([
            Paragraph(edital, cell_style),
            Paragraph(objeto, cell_style),
            Paragraph(formatar_valor(valor_num), ParagraphStyle('ValR', parent=cell_style, alignment=2)),
            Paragraph(data_br, ParagraphStyle('DateC', parent=cell_style, alignment=1)),
        ])

    sub_table = Table(sub_data, colWidths=sub_col_widths, repeatRows=1)
    sub_style = TableStyle([
        # Sub-cabeçalho das colunas
        ('BACKGROUND', (0, 0), (-1, 0), colors.Color(0.15, 0.35, 0.55)),
        ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 1), (-1, -1), 8),
        ('GRID', (0, 0), (-1, -1), 0.4, colors.Color(0.75, 0.75, 0.75)),
        ('LINEBELOW', (0, 0), (-1, 0), 1.0, colors.Color(0.15, 0.35, 0.55)),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, colors.Color(0.96, 0.96, 0.98)]),
        # Borda esquerda azul para indicar hierarquia
        ('LINEBEFORE', (0, 0), (0, -1), 3, colors.Color(0, 0.2, 0.4)),
    ])

    for row_idx in linhas_passadas:
        sub_style.add('BACKGROUND', (0, row_idx), (-1, row_idx), colors.Color(1.0, 0.96, 0.65))

    sub_table.setStyle(sub_style)
    elements.append(sub_table)
    elements.append(Spacer(1, 12))  # espaço entre blocos

    return elements


def gerar_pdf_geral(payload, arquivo_saida):
    dados_licitacoes = payload.get('licitacoes', []) if isinstance(payload, dict) else payload
    data_inicio = payload.get('data_inicio') if isinstance(payload, dict) else None
    data_fim = payload.get('data_fim') if isinstance(payload, dict) else None

    hoje = date.today()

    # ── Agrupar por órgão ────────────────────────────────────
    agrupado = defaultdict(list)
    for licitacao in dados_licitacoes:
        props = licitacao.get('properties', {})
        orgao = extrair_orgao(props)
        agrupado[orgao].append(licitacao)

    # Ordenar cada grupo por data internamente
    for orgao in agrupado:
        agrupado[orgao].sort(key=lambda l: parse_date_iso(get_date_raw(l.get('properties', {}), 'DATA E HORA')) or date.min)

    # Ordenar órgãos pela regra de negócio
    orgaos_ordenados = sorted(agrupado.keys(), key=ordem_orgao)

    # ── Documento A4 retrato ─────────────────────────────────
    doc = SimpleDocTemplate(
        arquivo_saida,
        pagesize=A4,
        rightMargin=20,
        leftMargin=20,
        topMargin=30,
        bottomMargin=30
    )
    styles = getSampleStyleSheet()
    elements = []

    # ── Cabeçalho do relatório ───────────────────────────────
    titulo_style = ParagraphStyle('TituloGeral', parent=styles['Title'], fontName='Helvetica-Bold', fontSize=14, alignment=1, textColor=colors.Color(0, 0.2, 0.4), spaceAfter=6)
    header_style = ParagraphStyle('HeaderGeral', parent=styles['Normal'], fontSize=8, fontName='Helvetica', textColor=colors.Color(0.4, 0.4, 0.4), alignment=1, spaceAfter=12)

    elements.append(Paragraph('Relatório Geral por Órgão', titulo_style))
    periodo_txt = ''
    if data_inicio and data_fim:
        periodo_txt = f'Período: {formatar_data_br(data_inicio)} a {formatar_data_br(data_fim)} | '
    elements.append(Paragraph(f'{periodo_txt}Gerado: {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}', header_style))

    # ── Legenda das linhas amarelas ──────────────────────────
    legenda_style = ParagraphStyle('Legenda', parent=styles['Normal'], fontSize=7, textColor=colors.Color(0.45, 0.35, 0), spaceAfter=10, backColor=colors.Color(1.0, 0.98, 0.85), borderPadding=4, leftIndent=0)
    elements.append(Paragraph('⚠ Linhas em amarelo indicam licitações com data anterior à data atual.', legenda_style))
    elements.append(Spacer(1, 4))

    # ── Blocos por órgão ─────────────────────────────────────
    total_geral = 0.0
    total_licitacoes = 0

    for orgao in orgaos_ordenados:
        licitacoes_orgao = agrupado[orgao]
        total_geral += sum(converter_valor(get_rich_text(l.get('properties', {}), 'VALOR DA OBRA') or '0') for l in licitacoes_orgao)
        total_licitacoes += len(licitacoes_orgao)
        elements.extend(_construir_bloco_orgao(orgao, licitacoes_orgao, styles, hoje))

    # ── Totais finais ────────────────────────────────────────
    elements.append(Spacer(1, 10))
    total_style = ParagraphStyle('TotalGeral', parent=styles['Normal'], fontSize=14, fontName='Helvetica-Bold', textColor=colors.Color(0, 0.4, 0), alignment=2, backColor=colors.Color(0.95, 0.98, 0.95), borderWidth=2, borderColor=colors.Color(0, 0.4, 0), borderRadius=6, padding=20, spaceBefore=10, spaceAfter=6, leftIndent=40, rightIndent=40, leading=18)
    resumo_style = ParagraphStyle('ResumoGeral', parent=styles['Normal'], fontSize=8, fontName='Helvetica-Bold', textColor=colors.Color(0.3, 0.3, 0.3), alignment=2, spaceAfter=8)

    elements.append(Paragraph(f'TOTAL GERAL: {formatar_valor(total_geral)}', total_style))
    elements.append(Paragraph(f'Órgãos consolidados: {len(orgaos_ordenados)} | Licitações somadas: {total_licitacoes}', resumo_style))

    # ── Rodapé ───────────────────────────────────────────────
    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 7)
        canvas.setFillColorRGB(0.5, 0.5, 0.5)
        canvas.drawCentredString(doc.pagesize[0] / 2, 15, f'Página {doc.page} • Gerado em {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}')
        canvas.restoreState()

    doc.build(elements, onFirstPage=on_page, onLaterPages=on_page)


# ─────────────────────────────────────────────────────────────
# DISPATCHER
# ─────────────────────────────────────────────────────────────

def gerar_pdf(payload, local_busca, arquivo_saida):
    modo = payload.get('modo', 'detalhado') if isinstance(payload, dict) else 'detalhado'
    local_norm = str(local_busca or '').strip().lower()
    if modo == 'geral' or local_norm == 'geral':
        gerar_pdf_geral(payload, arquivo_saida)
    else:
        gerar_pdf_detalhado(payload, local_busca, arquivo_saida)
    print(f'PDF gerado: {arquivo_saida}')


def main():
    if len(sys.argv) != 4:
        print('Uso: python gerador_pdf.py <arquivo_json> <local_busca> <arquivo_saida>')
        sys.exit(1)

    arquivo_json = sys.argv[1]
    local_busca = sys.argv[2]
    arquivo_saida = sys.argv[3]

    try:
        with open(arquivo_json, 'r', encoding='utf-8') as f:
            dados = json.load(f)

        if isinstance(dados, dict):
            total = len(dados.get('licitacoes', []))
        elif isinstance(dados, list):
            total = len(dados)
        else:
            print('ERRO: JSON inválido para processamento')
            sys.exit(1)

        print(f'Processando {total} licitações para {local_busca}')
        gerar_pdf(dados, local_busca, arquivo_saida)
        print(f'PDF gerado com sucesso: {arquivo_saida}')
    except FileNotFoundError:
        print(f'ERRO: Arquivo não encontrado: {arquivo_json}')
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f'ERRO: JSON inválido: {e}')
        sys.exit(1)
    except Exception as e:
        print(f'ERRO: {e}')
        sys.exit(1)


if __name__ == '__main__':
    main()