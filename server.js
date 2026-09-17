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
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));

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
        status: row.entrou ? "entrou" : "não entrou",
        entradaEm: row.timestamp_entrada
            ? new Date(row.timestamp_entrada).toISOString()
            : null
    };
}

// ======================================================
// POSTGRESQL / SUPABASE
// ======================================================

async function iniciarBanco() {
    await pool.query(`
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

    await pool.query(`
        ALTER TABLE pessoas
            ADD COLUMN IF NOT EXISTS familia VARCHAR(120) NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS responsavel VARCHAR(120) NOT NULL DEFAULT '',
            ADD COLUMN IF NOT EXISTS tipo VARCHAR(20) NOT NULL DEFAULT 'adulto',
            ADD COLUMN IF NOT EXISTS codigo VARCHAR(32) NULL,
            ADD COLUMN IF NOT EXISTS familia_codigo VARCHAR(32) NULL
    `);

    // "adolescente" tem 11 letras; amplia a coluna antiga sem apagar cadastros.
    await pool.query("ALTER TABLE pessoas ALTER COLUMN tipo TYPE VARCHAR(20)");

    // Compatibilidade: conserva valores antigos, mas CPF deixa de ser exigido.
    await pool.query("ALTER TABLE pessoas ALTER COLUMN cpf DROP NOT NULL");

    await pool.query("CREATE SEQUENCE IF NOT EXISTS pessoas_id_seq");
    await pool.query(`
        SELECT setval(
            'pessoas_id_seq',
            GREATEST(COALESCE(MAX(id), 0), 1),
            COALESCE(MAX(id), 0) > 0
        )
        FROM pessoas
    `);
    await pool.query(`
        ALTER TABLE pessoas
        ALTER COLUMN id SET DEFAULT nextval('pessoas_id_seq')
    `);

    await pool.query(`
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

    await pool.query(
        "CREATE INDEX IF NOT EXISTS pessoas_nome_idx ON pessoas (nome)"
    );
    await pool.query(
        "CREATE INDEX IF NOT EXISTS pessoas_familia_idx ON pessoas (familia)"
    );
    await pool.query(
        "CREATE INDEX IF NOT EXISTS pessoas_tipo_idx ON pessoas (tipo)"
    );
    await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS pessoas_codigo_uidx
        ON pessoas (codigo)
        WHERE codigo IS NOT NULL
    `);

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
            SELECT * FROM pessoas
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

function validarCadastroFamilia(corpo) {
    const responsavel = limparTexto(corpo.responsavel);
    const familia = limparTexto(corpo.familia) || responsavel;
    const recebidos = Array.isArray(corpo.integrantes) ? corpo.integrantes : [];
    if (recebidos.some(item => !["adulto", "crianca", "adolescente"].includes(normalizarTexto(item?.tipo || "adulto")))) {
        return { erro: "Escolha Adulto, Criança ou Adolescente para cada integrante." };
    }
    const integrantes = recebidos.map(item => ({
        id: item?.id == null ? null : String(item.id),
        nome: limparTexto(item?.nome),
        tipo: limparTipo(item?.tipo)
    }));

    if (!responsavel) return { erro: "Informe o nome completo do responsável." };
    if (integrantes.length === 0) {
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
        FROM pessoas
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

async function cadastrarFamilia(req, res) {
    const validacao = validarCadastroFamilia(req.body || {});
    if (validacao.erro) return res.status(400).json({ erro: validacao.erro });

    try {
        if (req.body.confirmarDuplicados !== true) {
            const duplicados = await detectarDuplicados(validacao.integrantes);
            if (duplicados.length > 0) {
                return res.status(409).json({
                    erro: "Encontramos nomes iguais ou escritos de forma parecida.",
                    precisaConfirmacao: true,
                    duplicados
                });
            }
        }

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            const familiaCodigo = gerarCodigo("FAM");
            const cadastrados = [];

            for (const integrante of validacao.integrantes) {
                const { rows } = await client.query(`
                    INSERT INTO pessoas (
                        nome, familia, responsavel, tipo, codigo, familia_codigo,
                        entrou, horario, data_entrada, timestamp_entrada
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, FALSE, '', '', NULL)
                    RETURNING *
                `, [
                    integrante.nome,
                    validacao.familia,
                    validacao.responsavel,
                    integrante.tipo,
                    gerarCodigo("CONV"),
                    familiaCodigo
                ]);
                cadastrados.push(linhaParaVisitante(rows[0]));
            }

            await client.query("COMMIT");
            avisarTodos();
            return res.status(201).json({
                familia: validacao.familia,
                responsavel: validacao.responsavel,
                familiaCodigo,
                visitantes: cadastrados
            });
        } catch (erro) {
            await client.query("ROLLBACK");
            throw erro;
        } finally {
            client.release();
        }
    } catch (erro) {
        console.error("Erro ao cadastrar família:", erro);
        return res.status(500).json({ erro: mensagemErroCadastro(erro) });
    }
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

app.patch("/api/familias/:familiaCodigo", async (req, res) => {
    const corpo = req.body || {};
    const familiaCodigo = limparTexto(req.params.familiaCodigo, 32);
    const validacao = validarCadastroFamilia(corpo);
    if (validacao.erro) return res.status(400).json({ erro: validacao.erro });
    if (!familiaCodigo || !Array.isArray(corpo.originais) || !corpo.originais.length) {
        return res.status(400).json({ erro: "Abra novamente a família para editar." });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        // Serializa edições desta família entre os computadores.
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["familia:" + familiaCodigo]);
        const { rows: atuais } = await client.query(
            "SELECT * FROM pessoas WHERE familia_codigo = $1 ORDER BY id FOR UPDATE",
            [familiaCodigo]
        );
        const recusar = async (status, erro) => {
            await client.query("ROLLBACK");
            return res.status(status).json({ erro });
        };
        if (!atuais.length) return await recusar(404, "Família não encontrada.");
        if (retratoFamilia(atuais.map(linhaParaVisitante)) !== retratoFamilia(corpo.originais)) {
            return await recusar(409, "Esta família foi alterada em outro computador ou no banco. Feche e abra a edição novamente para carregar os dados atuais.");
        }

        const porId = new Map(atuais.map(pessoa => [String(pessoa.id), pessoa]));
        const idsRecebidos = validacao.integrantes.filter(item => item.id).map(item => item.id);
        if (new Set(idsRecebidos).size !== idsRecebidos.length ||
            idsRecebidos.some(id => !porId.has(id)) || idsRecebidos.length !== atuais.length) {
            return await recusar(400, "Os integrantes existentes devem continuar na mesma família. Reabra a edição.");
        }

        const nomesAlterados = validacao.integrantes.filter(item =>
            !item.id || item.nome !== porId.get(item.id).nome
        );
        if (corpo.confirmarDuplicados !== true && nomesAlterados.length) {
            const duplicados = await detectarDuplicados(nomesAlterados, client, nomesAlterados.filter(item => item.id).map(item => item.id));
            if (duplicados.length) {
                await client.query("ROLLBACK");
                return res.status(409).json({
                    erro: "Encontramos nomes iguais ou escritos de forma parecida.",
                    precisaConfirmacao: true,
                    duplicados
                });
            }
        }

        // Quando o título era o próprio responsável, acompanha a troca do nome.
        if (validacao.familia === atuais[0].familia && atuais[0].familia === atuais[0].responsavel) {
            validacao.familia = validacao.responsavel;
        }
        await client.query(
            "UPDATE pessoas SET familia = $2, responsavel = $3 WHERE familia_codigo = $1",
            [familiaCodigo, validacao.familia, validacao.responsavel]
        );
        for (const integrante of validacao.integrantes) {
            if (integrante.id) {
                // Conserva ID, código, entrada e horário já registrados.
                await client.query(
                    "UPDATE pessoas SET nome = $3, tipo = $4 WHERE id::text = $1 AND familia_codigo = $2",
                    [integrante.id, familiaCodigo, integrante.nome, integrante.tipo]
                );
            } else {
                await client.query(`
                    INSERT INTO pessoas (
                        nome, familia, responsavel, tipo, codigo, familia_codigo,
                        entrou, horario, data_entrada, timestamp_entrada
                    ) VALUES ($1, $2, $3, $4, $5, $6, FALSE, '', '', NULL)
                `, [integrante.nome, validacao.familia, validacao.responsavel,
                    integrante.tipo, gerarCodigo("CONV"), familiaCodigo]);
            }
        }
        const { rows } = await client.query(
            "SELECT * FROM pessoas WHERE familia_codigo = $1 ORDER BY id",
            [familiaCodigo]
        );
        await client.query("COMMIT");
        avisarTodos();
        return res.json({
            familia: validacao.familia,
            responsavel: validacao.responsavel,
            familiaCodigo,
            visitantes: rows.map(linhaParaVisitante)
        });
    } catch (erro) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        console.error("Erro ao editar família:", erro);
        return res.status(500).json({ erro: mensagemErroCadastro(erro) });
    } finally {
        client?.release();
    }
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

app.patch("/api/visitantes/status/todos", async (req, res) => {
    try {
        const momento = momentoSP();

        const resultado = await pool.query(`
            UPDATE pessoas
            SET
                entrou = TRUE,
                horario = $1,
                data_entrada = $2,
                timestamp_entrada = $3::timestamptz
            WHERE entrou = FALSE
            RETURNING id
        `, [
            momento.hora,
            momento.data,
            momento.iso
        ]);

        avisarTodos();

        return res.json({
            ok: true,
            atualizados: resultado.rowCount
        });
    } catch (erro) {
        console.error("Erro ao marcar todos como presentes:", erro);
        return res.status(500).json({
            erro: "Não foi possível marcar todos como presentes."
        });
    }
});


// ======================================================
// MARCAR UMA FAMÍLIA INTEIRA COMO PRESENTE
// ======================================================

app.patch("/api/familias/:familiaCodigo/status", async (req, res) => {
    try {
        const familiaCodigo = limparTexto(req.params.familiaCodigo, 32);
        const status = req.body?.status;

        if (status !== "entrou") {
            return res.status(400).json({
                erro: "Status inválido."
            });
        }

        if (!familiaCodigo) {
            return res.status(400).json({
                erro: "Família inválida."
            });
        }

        const momento = momentoSP();

        const resultado = await pool.query(`
            UPDATE pessoas
            SET
                entrou = TRUE,
                horario = $2,
                data_entrada = $3,
                timestamp_entrada = $4::timestamptz
            WHERE familia_codigo = $1
              AND entrou = FALSE
            RETURNING id
        `, [
            familiaCodigo,
            momento.hora,
            momento.data,
            momento.iso
        ]);

        avisarTodos();

        return res.json({
            ok: true,
            atualizados: resultado.rowCount,
            familiaCodigo
        });

    } catch (erro) {
        console.error("Erro ao marcar família como presente:", erro);

        return res.status(500).json({
            erro: "Não foi possível marcar a família como presente."
        });
    }
});

// ======================================================
// MARCAR OU DESFAZER ENTRADA
// ======================================================

app.patch("/api/visitantes/:id/status", async (req, res) => {
    try {
        const id = String(req.params.id);
        const status = req.body.status;
        if (status !== "entrou" && status !== "não entrou") {
            return res.status(400).json({ erro: "Status inválido." });
        }

        const entrou = status === "entrou";
        const momento = momentoSP();
        const { rows } = await pool.query(`
            UPDATE pessoas
            SET
                entrou = $2,
                horario = CASE WHEN $2 THEN $3 ELSE '' END,
                data_entrada = CASE WHEN $2 THEN $4 ELSE '' END,
                timestamp_entrada = CASE WHEN $2 THEN $5::timestamptz ELSE NULL END
            WHERE id::text = $1
            RETURNING *
        `, [id, entrou, momento.hora, momento.data, momento.iso]);

        if (!rows[0]) {
            return res.status(404).json({ erro: "Visitante não encontrado." });
        }

        const visitante = linhaParaVisitante(rows[0]);
        avisarTodos();
        return res.json(visitante);
    } catch (erro) {
        console.error("Erro ao alterar status:", erro);
        return res.status(500).json({ erro: "Não foi possível alterar o status." });
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
            SELECT * FROM pessoas
            ORDER BY familia ASC, nome ASC
        `);
        const visitantes = rows.map(linhaParaVisitante);
        const presentes = visitantes.filter(pessoa => pessoa.status === "entrou");
        const ausentes = visitantes.filter(pessoa => pessoa.status !== "entrou");
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
            `Ausentes: ${ausentes.length}`,
            ""
        ];

        adicionarSecaoRelatorio(linhas, "PRESENTES", presentes, formatarData);
        adicionarSecaoRelatorio(linhas, "AUSENTES", ausentes, formatarData);

        const arquivo = "\uFEFF" + linhas.join("\r\n");
        const dataArquivo = agora.toISOString().slice(0, 10);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="relatorio-presentes-ausentes-${dataArquivo}.txt"`
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
        const banco = await pool.query("SELECT COUNT(*)::int AS total FROM pessoas");
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
