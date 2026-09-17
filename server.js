const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const HOST = "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const LEGACY_DB_FILE = path.join(__dirname, "visitantes.json");

if (!process.env.DATABASE_URL) {
    console.error("ERRO: DATABASE_URL não foi configurada no Render.");
    process.exit(1);
}

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
const VERSAO_INTERFACE = "3";
app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)
        && req.get("X-Controle-Versao") !== VERSAO_INTERFACE) {
        return res.status(409).json({ codigo: "ATUALIZACAO_NECESSARIA", erro: "O sistema foi atualizado. Aperte Ctrl + F5 antes de continuar." });
    }
    next();
});
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));
app.get("/api/versao", (req, res) => res.json({ versao: VERSAO_INTERFACE }));

// ======================================================
// NOMES, TIPOS E IDENTIFICADORES
// ======================================================

function limparTexto(valor, limite = 120) {
    return String(valor || "")
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, limite);
}

function normalizarTexto(valor) {
    return limparTexto(valor, 300)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizarFonetico(valor) {
    return normalizarTexto(valor)
        .replace(/ph/g, "f")
        .replace(/th/g, "t")
        .replace(/y/g, "i")
        .replace(/qu/g, "c")
        .replace(/k/g, "c")
        .replace(/w/g, "v")
        .replace(/ss/g, "s")
        .replace(/(.)\1+/g, "$1")
        .replace(/\b(da|de|do|das|dos)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function distanciaLevenshtein(a, b) {
    const esquerda = String(a || "");
    const direita = String(b || "");
    if (esquerda === direita) return 0;
    if (!esquerda.length) return direita.length;
    if (!direita.length) return esquerda.length;

    const anterior = Array.from(
        { length: direita.length + 1 },
        (_, indice) => indice
    );

    for (let i = 1; i <= esquerda.length; i++) {
        const atual = [i];
        for (let j = 1; j <= direita.length; j++) {
            const custo = esquerda[i - 1] === direita[j - 1] ? 0 : 1;
            atual[j] = Math.min(
                atual[j - 1] + 1,
                anterior[j] + 1,
                anterior[j - 1] + custo
            );
        }
        for (let j = 0; j < atual.length; j++) anterior[j] = atual[j];
    }

    return anterior[direita.length];
}

function nomesParecidos(primeiro, segundo) {
    const a = normalizarFonetico(primeiro);
    const b = normalizarFonetico(segundo);
    if (!a || !b) return false;
    if (a === b) return true;

    const maior = Math.max(a.length, b.length);
    const distancia = distanciaLevenshtein(a, b);
    const limite = maior >= 16 ? 3 : maior >= 8 ? 2 : 1;
    return distancia <= limite || 1 - distancia / maior >= 0.86;
}

function limparTipo(valor) {
    const tipo = normalizarTexto(valor);
    return ["crianca", "adolescente"].includes(tipo) ? tipo : "adulto";
}

function gerarCodigo(prefixo) {
    return `${prefixo}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function linhaParaVisitante(row) {
    return {
        id: String(row.id),
        codigo: row.codigo || `CONV-${row.id}`,
        nome: row.nome,
        familia: row.familia || "Família não informada",
        responsavel: row.responsavel || row.nome,
        tipo: limparTipo(row.tipo),
        familiaCodigo: row.familia_codigo || `FAM-${row.id}`,
        status: row.entrou ? "entrou" : row.nao_veio ? "nao_veio" : "não entrou",
        criadoEm: row.criado_em ? new Date(row.criado_em).toISOString() : null,
        adicionadoEm: row.cadastrado_pelo_site_em ? new Date(row.cadastrado_pelo_site_em).toISOString() : null,
        versao: crypto.createHash("sha256").update(JSON.stringify([
            String(row.id), row.nome, row.familia, row.responsavel, row.tipo,
            row.entrou, Boolean(row.nao_veio), row.timestamp_entrada, row.excluido_em
        ])).digest("hex"),
        entradaEm: row.timestamp_entrada
            ? new Date(row.timestamp_entrada).toISOString()
            : null
    };
}

// ======================================================
// POSTGRESQL / SUPABASE
// ======================================================

async function iniciarBanco() {
    const client = await pool.connect();
    try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('controle-acesso-migracao-v3'))");
    await client.query(`
        CREATE TABLE IF NOT EXISTS pessoas (
            id BIGSERIAL PRIMARY KEY,
            nome VARCHAR(120) NOT NULL,
            cpf VARCHAR(64) NULL UNIQUE,
            familia VARCHAR(120) NOT NULL DEFAULT '',
            responsavel VARCHAR(120) NOT NULL DEFAULT '',
            tipo VARCHAR(20) NOT NULL DEFAULT 'adulto',
            codigo VARCHAR(32) NULL,
            familia_codigo VARCHAR(32) NULL,
            entrou BOOLEAN NOT NULL DEFAULT FALSE,
            horario VARCHAR(8) NOT NULL DEFAULT '',
            data_entrada VARCHAR(10) NOT NULL DEFAULT '',
            timestamp_entrada TIMESTAMPTZ NULL,
            criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await client.query(`
        ALTER TABLE pessoas
            ADD COLUMN IF NOT EXISTS familia VARCHAR(120) NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS responsavel VARCHAR(120) NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'adulto',
            ADD COLUMN IF NOT EXISTS codigo VARCHAR(32) NULL,
            ADD COLUMN IF NOT EXISTS familia_codigo VARCHAR(32) NULL,
            ADD COLUMN IF NOT EXISTS nao_veio BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS excluido_em TIMESTAMPTZ NULL,
            ADD COLUMN IF NOT EXISTS cadastrado_pelo_site_em TIMESTAMPTZ NULL,
            ADD COLUMN IF NOT EXISTS criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    // "adolescente" tem 11 letras; amplia a coluna antiga sem apagar cadastros.
    await client.query("ALTER TABLE pessoas ALTER COLUMN tipo TYPE VARCHAR(20)");

    // Compatibilidade: conserva valores antigos, mas CPF deixa de ser exigido.
    await client.query("ALTER TABLE pessoas ALTER COLUMN cpf DROP NOT NULL");

    await client.query("CREATE SEQUENCE IF NOT EXISTS pessoas_id_seq");
    await client.query(`
        SELECT setval(
            'pessoas_id_seq',
            GREATEST(COALESCE(MAX(id), 0), (SELECT last_value FROM pessoas_id_seq), 1),
            TRUE
        )
        FROM pessoas
    `);
    await client.query(`
        ALTER TABLE pessoas
        ALTER COLUMN id SET DEFAULT nextval('pessoas_id_seq')
    `);

    await client.query(`
        UPDATE pessoas
        SET
            familia = CASE WHEN BTRIM(familia) = '' THEN nome ELSE familia END,
            responsavel = CASE
                WHEN BTRIM(responsavel) = '' THEN nome
                ELSE responsavel
            END,
            tipo = CASE
                WHEN LOWER(BTRIM(tipo)) IN ('crianca', 'criança') THEN 'crianca'
                WHEN LOWER(BTRIM(tipo)) = 'adolescente' THEN 'adolescente'
                ELSE 'adulto'
            END,
            codigo = COALESCE(NULLIF(codigo, ''), 'CONV-' || id::text),
            familia_codigo = COALESCE(
                NULLIF(familia_codigo, ''),
                'FAM-' || id::text
            )
    `);

    await client.query(
        "CREATE INDEX IF NOT EXISTS pessoas_nome_idx ON pessoas (nome)"
    );
    await client.query(
        "CREATE INDEX IF NOT EXISTS pessoas_familia_idx ON pessoas (familia)"
    );
    await client.query(
        "CREATE INDEX IF NOT EXISTS pessoas_tipo_idx ON pessoas (tipo)"
    );
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS pessoas_codigo_uidx
        ON pessoas (codigo)
        WHERE codigo IS NOT NULL
    `);

    await client.query("COMMIT");
    } catch (erro) {
        await client.query("ROLLBACK").catch(() => {});
        throw erro;
    } finally {
        client.release();
    }
    await importarVisitantesLegadosSeNecessario();
}

async function importarVisitantesLegadosSeNecessario() {
    const contagem = await pool.query("SELECT COUNT(*)::int AS total FROM pessoas");
    if (contagem.rows[0].total > 0) {
        console.log(`Banco online com ${contagem.rows[0].total} visitante(s).`);
        return;
    }

    if (!fs.existsSync(LEGACY_DB_FILE)) {
        console.log("Banco online e vazio. Nenhum visitantes.json para importar.");
        return;
    }

    let lista;
    try {
        const texto = fs.readFileSync(LEGACY_DB_FILE, "utf8").trim();
        if (!texto) return;
        lista = JSON.parse(texto);
    } catch (erro) {
        console.warn("Não foi possível ler visitantes.json:", erro.message);
        return;
    }

    if (!Array.isArray(lista) || lista.length === 0) return;

    const client = await pool.connect();
    let importados = 0;
    try {
        await client.query("BEGIN");

        for (const pessoa of lista) {
            const nome = limparTexto(pessoa?.nome);
            if (!nome) continue;

            const entrou = pessoa.status === "entrou" || pessoa.entrou === true;
            const entradaEm = pessoa.entradaEm || pessoa.timestampEntrada || null;
            let horario = "";
            let dataEntrada = "";

            if (entrou && entradaEm) {
                const data = new Date(entradaEm);
                if (!Number.isNaN(data.getTime())) {
                    horario = data.toLocaleTimeString("pt-BR", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                        timeZone: "America/Sao_Paulo"
                    });
                    dataEntrada = data.toLocaleDateString("pt-BR", {
                        timeZone: "America/Sao_Paulo"
                    });
                }
            }

            const resultado = await client.query(`
                INSERT INTO pessoas (
                    nome, familia, responsavel, tipo, codigo, familia_codigo,
                    entrou, horario, data_entrada, timestamp_entrada
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT DO NOTHING
            `, [
                nome,
                limparTexto(pessoa.familia) || nome,
                limparTexto(pessoa.responsavel) || nome,
                limparTipo(pessoa.tipo),
                gerarCodigo("CONV"),
                gerarCodigo("FAM"),
                entrou,
                horario,
                dataEntrada,
                entrou ? entradaEm : null
            ]);

            importados += resultado.rowCount;
        }

        await client.query("COMMIT");
        console.log(`Importação inicial concluída: ${importados} visitante(s).`);
    } catch (erro) {
        await client.query("ROLLBACK");
        throw erro;
    } finally {
        client.release();
    }
}

function momentoSP() {
    const agora = new Date();
    return {
        data: agora.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }),
        hora: agora.toLocaleTimeString("pt-BR", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
            timeZone: "America/Sao_Paulo"
        }),
        iso: agora.toISOString()
    };
}

// ======================================================
// SINCRONIZAÇÃO ENTRE COMPUTADORES
// ======================================================

const clientes = new Set();

app.get("/api/eventos", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ tipo: "conectado" })}\n\n`);
    clientes.add(res);

    const keepAlive = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch (_) {}
    }, 25000);

    req.on("close", () => {
        clearInterval(keepAlive);
        clientes.delete(res);
    });
});

function avisarTodos() {
    const mensagem = JSON.stringify({ tipo: "atualizacao", data: Date.now() });
    for (const cliente of [...clientes]) {
        try {
            cliente.write(`data: ${mensagem}\n\n`);
        } catch (_) {
            clientes.delete(cliente);
        }
    }
}

// ======================================================
// LISTAGEM
// ======================================================

app.get("/api/visitantes", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT * FROM pessoas WHERE excluido_em IS NULL
            ORDER BY familia ASC, nome ASC, id ASC
        `);
        res.setHeader("Cache-Control", "no-store");
        res.json(rows.map(linhaParaVisitante));
    } catch (erro) {
        console.error("Erro ao listar visitantes:", erro);
        res.status(500).json({ erro: "Não foi possível carregar os visitantes." });
    }
});

// ======================================================
// CADASTRO DE FAMÍLIA E INTEGRANTES
// ======================================================

function validarCadastroFamilia(corpo, permitirVazia = false) {
    const responsavel = limparTexto(corpo.responsavel);
    const familia = limparTexto(corpo.familia) || responsavel;
    const recebidos = Array.isArray(corpo.integrantes) ? corpo.integrantes : [];
    if (recebidos.some(item => !["adulto", "crianca", "adolescente"].includes(normalizarTexto(item?.tipo || "adulto")))) {
        return { erro: "Escolha Adulto, Criança ou Adolescente para cada integrante." };
    }
    if (recebidos.some(item => !["entrou", "não entrou", "nao_veio"].includes(item?.status || "não entrou"))) {
        return { erro: "Escolha uma situação válida para cada integrante." };
    }
    const integrantes = recebidos.map(item => ({
        id: item?.id == null ? null : String(item.id),
        nome: limparTexto(item?.nome),
        tipo: limparTipo(item?.tipo),
        status: item?.status || "não entrou",
        versao: String(item?.versao || "")
    }));

    if (!responsavel) return { erro: "Informe o nome completo do responsável." };
    if (integrantes.length === 0 && !permitirVazia) {
        return { erro: "Adicione pelo menos um integrante." };
    }
    if (integrantes.some(item => !item.nome)) {
        return { erro: "Preencha o nome de todos os integrantes." };
    }
    return { familia, responsavel, integrantes };
}

async function detectarDuplicados(integrantes, consulta = pool, idsIgnorados = []) {
    const existentes = await consulta.query(`
        SELECT id, nome, familia, responsavel, codigo
        FROM pessoas WHERE excluido_em IS NULL
        ORDER BY nome ASC
    `);

    const duplicados = [];
    const ignorados = new Set(idsIgnorados.map(String));
    const comparados = existentes.rows
        .filter(item => !ignorados.has(String(item.id)))
        .map(item => ({ ...item, origem: "banco" }));

    for (const integrante of integrantes) {
        for (const candidato of comparados) {
            if (!nomesParecidos(integrante.nome, candidato.nome)) continue;
            duplicados.push({
                novoNome: integrante.nome,
                nomeEncontrado: candidato.nome,
                familiaEncontrada: candidato.familia || "Não informada",
                responsavelEncontrado: candidato.responsavel || candidato.nome,
                codigoEncontrado: candidato.codigo || null,
                origem: candidato.origem
            });
            if (duplicados.length >= 30) return duplicados;
        }

        comparados.push({
            nome: integrante.nome,
            familia: "neste novo cadastro",
            responsavel: "neste novo cadastro",
            codigo: null,
            origem: "novo"
        });
    }

    return duplicados;
}

async function inserirIntegrante(client, integrante, familia, responsavel, familiaCodigo) {
    const momento = momentoSP();
    const entrou = integrante.status === "entrou";
    const { rows } = await client.query(`
        INSERT INTO pessoas (
            nome, familia, responsavel, tipo, codigo, familia_codigo,
            entrou, horario, data_entrada, timestamp_entrada, nao_veio, cadastrado_pelo_site_em
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()) RETURNING *
    `, [integrante.nome, familia, responsavel, integrante.tipo, gerarCodigo("CONV"), familiaCodigo,
        entrou, entrou ? momento.hora : "", entrou ? momento.data : "", entrou ? momento.iso : null,
        integrante.status === "nao_veio"]);
    return linhaParaVisitante(rows[0]);
}

async function cadastrarFamilia(req, res) {
    const validacao = validarCadastroFamilia(req.body || {});
    if (validacao.erro) return res.status(400).json({ erro: validacao.erro });
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('controle-acesso-cadastros'))");
        if (req.body.confirmarDuplicados !== true) {
            const duplicados = await detectarDuplicados(validacao.integrantes, client);
            if (duplicados.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ erro: "Encontramos nomes iguais ou parecidos.", precisaConfirmacao: true, duplicados });
            }
        }
        const familiaCodigo = gerarCodigo("FAM");
        const cadastrados = [];
        for (const integrante of validacao.integrantes) {
            cadastrados.push(await inserirIntegrante(client, integrante, validacao.familia, validacao.responsavel, familiaCodigo));
        }
        await client.query("COMMIT");
        avisarTodos();
        return res.status(201).json({ familia: validacao.familia, responsavel: validacao.responsavel, familiaCodigo, visitantes: cadastrados });
    } catch (erro) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Erro ao cadastrar família:", erro);
        return res.status(500).json({ erro: mensagemErroCadastro(erro) });
    } finally { client?.release(); }
}

app.post("/api/familias", cadastrarFamilia);

function mensagemErroCadastro(erro) {
    if (erro.code === "23514") {
        return "O banco recusou um dos valores. Confira se a regra da coluna tipo no Supabase permite adulto, crianca e adolescente.";
    }
    return "Não foi possível salvar a família. Tente novamente.";
}

// Compara somente dados cadastrais: marcar uma entrada não impede a edição.
function retratoFamilia(pessoas) {
    return JSON.stringify(pessoas.map(pessoa => ({
        id: String(pessoa.id),
        nome: pessoa.nome,
        tipo: limparTipo(pessoa.tipo),
        familia: pessoa.familia,
        responsavel: pessoa.responsavel
    })).sort((a, b) => a.id.localeCompare(b.id)));
}

// Mantém o horário se a pessoa já está presente; alterações explícitas usam versão.
async function gravarStatus(client, id, status) {
    const momento = momentoSP();
    const { rows } = await client.query(`
        UPDATE pessoas SET
            horario = CASE WHEN $2 THEN CASE WHEN entrou THEN horario ELSE $4 END ELSE '' END,
            data_entrada = CASE WHEN $2 THEN CASE WHEN entrou THEN data_entrada ELSE $5 END ELSE '' END,
            timestamp_entrada = CASE WHEN $2 THEN CASE WHEN entrou THEN timestamp_entrada ELSE $6::timestamptz END ELSE NULL END,
            entrou = $2, nao_veio = $3
        WHERE id::text = $1 AND excluido_em IS NULL RETURNING *
    `, [String(id), status === "entrou", status === "nao_veio", momento.hora, momento.data, momento.iso]);
    return rows[0] ? linhaParaVisitante(rows[0]) : null;
}

app.patch("/api/familias/:familiaCodigo", async (req, res) => {
    const corpo = req.body || {};
    const familiaCodigo = limparTexto(req.params.familiaCodigo, 32);
    const validacao = validarCadastroFamilia(corpo, true);
    if (validacao.erro) return res.status(400).json({ erro: validacao.erro });
    if (!familiaCodigo || !Array.isArray(corpo.originais) || !corpo.originais.length || !Array.isArray(corpo.excluirIds)) {
        return res.status(400).json({ erro: "Abra novamente a família para editar." });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('controle-acesso-cadastros'))");
        const { rows: atuais } = await client.query(
            "SELECT * FROM pessoas WHERE familia_codigo = $1 AND excluido_em IS NULL ORDER BY id FOR UPDATE", [familiaCodigo]);
        const recusar = async (status, erro) => { await client.query("ROLLBACK"); return res.status(status).json({ erro }); };
        if (!atuais.length) return await recusar(404, "Família não encontrada.");
        if (retratoFamilia(atuais.map(linhaParaVisitante)) !== retratoFamilia(corpo.originais)) {
            return await recusar(409, "Esta família foi alterada em outro computador ou no banco. Feche e abra a edição novamente.");
        }
        const porId = new Map(atuais.map(pessoa => [String(pessoa.id), pessoa]));
        const originais = new Map(corpo.originais.map(pessoa => [String(pessoa.id), pessoa]));
        const excluirIds = corpo.excluirIds.map(String);
        const idsRecebidos = validacao.integrantes.filter(item => item.id).map(item => item.id);
        const todosIds = [...idsRecebidos, ...excluirIds];
        if (new Set(todosIds).size !== todosIds.length || todosIds.some(id => !porId.has(id)) || todosIds.length !== atuais.length) {
            return await recusar(400, "A lista de integrantes está incompleta. Reabra a edição.");
        }
        for (const id of excluirIds) {
            if (originais.get(id)?.versao !== linhaParaVisitante(porId.get(id)).versao) {
                return await recusar(409, "Uma pessoa que seria excluída foi alterada ou teve a entrada registrada. Reabra a edição para conferir.");
            }
        }
        if (excluirIds.some(id => normalizarTexto(porId.get(id).nome) === normalizarTexto(atuais[0].responsavel)) && validacao.integrantes.length &&
            !validacao.integrantes.some(item => normalizarTexto(item.nome) === normalizarTexto(validacao.responsavel))) {
            return await recusar(400, "Escolha outro integrante como responsável antes de excluir o responsável atual.");
        }
        for (const item of validacao.integrantes.filter(item => item.id)) {
            if (item.status !== originais.get(item.id)?.status && item.versao !== linhaParaVisitante(porId.get(item.id)).versao) {
                return await recusar(409, "A situação de um integrante mudou em outro computador. Reabra a edição para conferir.");
            }
        }
        // Compara o conjunto final inteiro, sem os integrantes removidos ou substituídos.
        if (corpo.confirmarDuplicados !== true && validacao.integrantes.some(item => !item.id || item.nome !== porId.get(item.id).nome)) {
            const duplicados = await detectarDuplicados(validacao.integrantes, client, [...porId.keys()]);
            if (duplicados.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({ erro: "Encontramos nomes iguais ou parecidos.", precisaConfirmacao: true, duplicados });
            }
        }
        for (const id of excluirIds) {
            // Exclusão reversível no banco: não participa de listas, busca, contagens ou TXT.
            await client.query("UPDATE pessoas SET excluido_em = NOW() WHERE id::text = $1", [id]);
        }
        if (validacao.familia === atuais[0].familia && atuais[0].familia === atuais[0].responsavel) validacao.familia = validacao.responsavel;
        await client.query("UPDATE pessoas SET familia = $2, responsavel = $3 WHERE familia_codigo = $1 AND excluido_em IS NULL",
            [familiaCodigo, validacao.familia, validacao.responsavel]);
        for (const integrante of validacao.integrantes) {
            if (integrante.id) {
                await client.query("UPDATE pessoas SET nome = $2, tipo = $3 WHERE id::text = $1", [integrante.id, integrante.nome, integrante.tipo]);
                // Se o operador não mudou a situação, conserva a entrada feita em outro PC.
                if (integrante.status !== originais.get(integrante.id).status) await gravarStatus(client, integrante.id, integrante.status);
            } else await inserirIntegrante(client, integrante, validacao.familia, validacao.responsavel, familiaCodigo);
        }
        const { rows } = await client.query("SELECT * FROM pessoas WHERE familia_codigo = $1 AND excluido_em IS NULL ORDER BY id", [familiaCodigo]);
        await client.query("COMMIT");
        avisarTodos();
        return res.json({ familia: validacao.familia, responsavel: validacao.responsavel, familiaCodigo, visitantes: rows.map(linhaParaVisitante), excluidos: excluirIds });
    } catch (erro) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Erro ao editar família:", erro);
        return res.status(500).json({ erro: mensagemErroCadastro(erro) });
    } finally { client?.release(); }
});

// Compatibilidade com clientes antigos da rota individual.
app.post("/api/visitantes", async (req, res) => {
    const nome = limparTexto(req.body?.nome);
    req.body = {
        familia: limparTexto(req.body?.familia) || nome,
        responsavel: limparTexto(req.body?.responsavel) || nome,
        integrantes: [{ nome, tipo: limparTipo(req.body?.tipo) }],
        confirmarDuplicados: req.body?.confirmarDuplicados === true
    };
    return cadastrarFamilia(req, res);
});


// ======================================================
// MARCAR TODOS COMO PRESENTES
// ======================================================

app.patch("/api/visitantes/status/todos", (req, res) => {
    res.status(400).json({ erro: "Selecione os integrantes dentro de cada família e escolha o destino." });
});

// Seleção explícita e transação: ou todos mudam, ou nenhum muda.
app.patch("/api/familias/:familiaCodigo/status", async (req, res) => {
    const status = req.body?.status;
    const selecionados = req.body?.pessoas;
    if (!["entrou", "não entrou", "nao_veio"].includes(status) || !Array.isArray(selecionados) || !selecionados.length ||
        selecionados.some(p => !p || !p.id || !p.versao) || new Set(selecionados.map(p => String(p.id))).size !== selecionados.length) {
        return res.status(400).json({ erro: "Selecione as pessoas e uma situação válida." });
    }
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const { rows } = await client.query(
            "SELECT * FROM pessoas WHERE familia_codigo = $1 AND excluido_em IS NULL ORDER BY id FOR UPDATE", [req.params.familiaCodigo]);
        const porId = new Map(rows.map(row => [String(row.id), linhaParaVisitante(row)]));
        if (selecionados.some(p => porId.get(String(p.id))?.versao !== p.versao)) {
            await client.query("ROLLBACK");
            return res.status(409).json({ erro: "A família mudou em outro computador. Confira a lista atualizada e selecione novamente." });
        }
        const atualizados = [];
        for (const p of selecionados) atualizados.push(await gravarStatus(client, p.id, status));
        await client.query("COMMIT");
        avisarTodos();
        res.json({ atualizados: atualizados.length, visitantes: atualizados });
    } catch (erro) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Erro ao mover integrantes:", erro);
        res.status(500).json({ erro: "Não foi possível mover os integrantes." });
    } finally { client?.release(); }
});

app.patch("/api/visitantes/:id/status", async (req, res) => {
    const { status, versao } = req.body || {};
    if (!["entrou", "não entrou", "nao_veio"].includes(status) || !versao) return res.status(400).json({ erro: "Atualize a lista e escolha uma situação válida." });
    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const { rows } = await client.query("SELECT * FROM pessoas WHERE id::text = $1 AND excluido_em IS NULL FOR UPDATE", [req.params.id]);
        if (!rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ erro: "Visitante não encontrado." }); }
        if (linhaParaVisitante(rows[0]).versao !== versao) {
            await client.query("ROLLBACK");
            return res.status(409).json({ erro: "Esta pessoa mudou em outro computador. Confira a lista atualizada e tente novamente." });
        }
        const visitante = await gravarStatus(client, req.params.id, status);
        await client.query("COMMIT");
        avisarTodos();
        return res.json(visitante);
    } catch (erro) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Erro ao alterar situação:", erro);
        return res.status(500).json({ erro: "Não foi possível alterar a situação." });
    } finally { client?.release(); }
});

app.get("/api/semelhantes", async (req, res) => {
    try {
        const { rows } = await pool.query("SELECT * FROM pessoas WHERE excluido_em IS NULL ORDER BY nome, id");
        const pessoas = rows.map(linhaParaVisitante);
        const pares = [];
        let total = 0;
        for (let i = 0; i < pessoas.length; i++) for (let j = i + 1; j < pessoas.length; j++) {
            if (!nomesParecidos(pessoas[i].nome, pessoas[j].nome)) continue;
            total++;
            if (pares.length < 200) pares.push({ a: pessoas[i], b: pessoas[j], exato: normalizarTexto(pessoas[i].nome) === normalizarTexto(pessoas[j].nome) });
        }
        res.json({ pares, total, limitado: total > pares.length });
    } catch (erro) {
        console.error("Erro ao comparar nomes:", erro);
        res.status(500).json({ erro: "Não foi possível conferir os nomes." });
    }
});

// ======================================================
// RELATÓRIO ÚNICO: PRESENTES E AUSENTES
// ======================================================

function formatarTipo(tipo) {
    return { adulto: "Adulto", crianca: "Criança", adolescente: "Adolescente" }[limparTipo(tipo)];
}

function adicionarSecaoRelatorio(linhas, titulo, pessoas, formatarData) {
    const adultos = pessoas.filter(pessoa => pessoa.tipo === "adulto").length;
    const criancas = pessoas.filter(pessoa => pessoa.tipo === "crianca").length;
    const adolescentes = pessoas.filter(pessoa => pessoa.tipo === "adolescente").length;
    linhas.push("===============================================");
    linhas.push(`${titulo} (${pessoas.length})`);
    linhas.push(`Adultos: ${adultos} | Crianças: ${criancas} | Adolescentes: ${adolescentes}`);
    linhas.push("===============================================");
    linhas.push("");

    if (pessoas.length === 0) {
        linhas.push("Nenhum convidado nesta seção.", "");
        return;
    }

    pessoas.forEach((pessoa, indice) => {
        linhas.push(`${indice + 1}. ${pessoa.nome} — ${formatarTipo(pessoa.tipo)}`);
        linhas.push(`Família: ${pessoa.familia} | Responsável: ${pessoa.responsavel}`);
        linhas.push(`ID: ${pessoa.codigo} | Código da família: ${pessoa.familiaCodigo}`);
        if (pessoa.status === "entrou") {
            const horario = pessoa.entradaEm
                ? formatarData.format(new Date(pessoa.entradaEm))
                : "Horário não registrado";
            linhas.push(`Entrada: ${horario}`);
        }
        linhas.push("");
    });
}

app.get("/exportar", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT * FROM pessoas WHERE excluido_em IS NULL
            ORDER BY familia ASC, nome ASC
        `);
        const visitantes = rows.map(linhaParaVisitante);
        const presentes = visitantes.filter(pessoa => pessoa.status === "entrou");
        const faltam = visitantes.filter(pessoa => pessoa.status === "não entrou");
        const naoVieram = visitantes.filter(pessoa => pessoa.status === "nao_veio");
        const agora = new Date();
        const formatarData = new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "short",
            timeStyle: "medium",
            timeZone: "America/Sao_Paulo"
        });
        const linhas = [
            "RELATÓRIO DE CONTROLE DE ACESSO",
            "",
            `Gerado em: ${formatarData.format(agora)}`,
            `Total cadastrado: ${visitantes.length}`,
            `Presentes: ${presentes.length}`,
            `Falta entrar: ${faltam.length}`,
            `Não veio: ${naoVieram.length}`,
            ""
        ];

        adicionarSecaoRelatorio(linhas, "JÁ ENTRARAM", presentes, formatarData);
        adicionarSecaoRelatorio(linhas, "FALTA ENTRAR", faltam, formatarData);
        adicionarSecaoRelatorio(linhas, "NÃO VEIO", naoVieram, formatarData);

        const arquivo = "\uFEFF" + linhas.join("\r\n");
        const dataArquivo = agora.toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="relatorio-tres-situacoes-${dataArquivo}.txt"`
        );
        return res.send(arquivo);
    } catch (erro) {
        console.error("Erro ao exportar relatório:", erro);
        return res.status(500).send("Não foi possível gerar o relatório.");
    }
});

// ======================================================
// SERVIÇO E FRONT-END
// ======================================================

app.get("/health", async (req, res) => {
    try {
        const banco = await pool.query("SELECT COUNT(*)::int AS total FROM pessoas WHERE excluido_em IS NULL");
        return res.json({
            ok: true,
            banco: "online",
            visitantes: banco.rows[0].total,
            frontend: fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
        });
    } catch (erro) {
        return res.status(503).json({ ok: false, banco: "offline", erro: erro.message });
    }
});

app.get("/", (req, res, next) => {
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) return res.sendFile(index);
    return next();
});

app.use((req, res) => res.status(404).send("Página não encontrada."));

iniciarBanco()
    .then(() => {
        app.listen(PORT, HOST, () => {
            console.log("");
            console.log("===============================================");
            console.log(" CONTROLE DE ACESSO ONLINE");
            console.log("===============================================");
            console.log(` Porta: ${PORT}`);
            console.log(` Front-end: ${path.join(PUBLIC_DIR, "index.html")}`);
            console.log(" Banco: Supabase/PostgreSQL");
            console.log("===============================================");
            console.log("");
        });
    })
    .catch(erro => {
        console.error("Não foi possível iniciar o banco:", erro);
        process.exit(1);
    });

