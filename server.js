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

// ======================================================
// CONFIGURAÇÕES
// ======================================================

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(
    express.static(PUBLIC_DIR, {
        etag: false,
        maxAge: 0
    })
);

// ======================================================
// BANCO POSTGRESQL (SUPABASE)
//
// Mantém a mesma API do projeto original. A única troca
// é que os dados deixam de ficar no visitantes.json e
// passam a ficar no PostgreSQL.
// ======================================================

function limparNome(nome) {
    return String(nome || "").trim();
}

function limparCPF(cpf) {
    return String(cpf || "").replace(/\D/g, "");
}

function linhaParaVisitante(row) {
    return {
        id: String(row.id),
        nome: row.nome,
        cpf: limparCPF(row.cpf),
        status: row.entrou ? "entrou" : "não entrou",
        entradaEm: row.timestamp_entrada
            ? new Date(row.timestamp_entrada).toISOString()
            : null
    };
}

async function iniciarBanco() {
    // Esta é a mesma tabela criada pela primeira versão cloud.
    // Assim, se ela já existe no Supabase, nenhum dado é perdido.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS pessoas (
            id BIGINT PRIMARY KEY,
            nome VARCHAR(120) NOT NULL,
            cpf VARCHAR(64) NOT NULL UNIQUE,
            entrou BOOLEAN NOT NULL DEFAULT FALSE,
            horario VARCHAR(8) NOT NULL DEFAULT '',
            data_entrada VARCHAR(10) NOT NULL DEFAULT '',
            timestamp_entrada TIMESTAMPTZ NULL,
            criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);

    await pool.query(
        "CREATE INDEX IF NOT EXISTS pessoas_nome_idx ON pessoas (nome)"
    );

    await importarVisitantesLegadosSeNecessario();
}

async function importarVisitantesLegadosSeNecessario() {
    const contagem = await pool.query(
        "SELECT COUNT(*)::int AS total FROM pessoas"
    );

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
        if (!texto) {
            console.log("Banco online e vazio. visitantes.json também está vazio.");
            return;
        }
        lista = JSON.parse(texto);
    } catch (erro) {
        console.warn("Não foi possível ler visitantes.json para importação:", erro.message);
        return;
    }

    if (!Array.isArray(lista) || lista.length === 0) {
        console.log("Banco online e vazio. visitantes.json não possui registros.");
        return;
    }

    const client = await pool.connect();
    let importados = 0;

    try {
        await client.query("BEGIN");

        for (let i = 0; i < lista.length; i++) {
            const pessoa = lista[i] || {};
            const nome = limparNome(pessoa.nome);
            const cpf = limparCPF(pessoa.cpf);

            if (!nome || cpf.length !== 11) continue;

            let id = Number(pessoa.id);
            if (!Number.isSafeInteger(id) || id <= 0) {
                id = Date.now() + i;
            }

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
                INSERT INTO pessoas
                    (id, nome, cpf, entrou, horario, data_entrada, timestamp_entrada)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT DO NOTHING
            `, [id, nome, cpf, entrou, horario, dataEntrada, entrou ? entradaEm : null]);

            importados += resultado.rowCount;
        }

        await client.query("COMMIT");
        console.log(`Importação inicial concluída: ${importados} visitante(s).`);
    } catch (erro) {
        await client.query("ROLLBACK");
        console.error("Falha ao importar visitantes.json:", erro);
        throw erro;
    } finally {
        client.release();
    }
}

function momentoSP() {
    const agora = new Date();
    return {
        data: agora.toLocaleDateString("pt-BR", {
            timeZone: "America/Sao_Paulo"
        }),
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
// SINCRONIZAÇÃO ENTRE OS COMPUTADORES
// ======================================================

const clientes = new Set();

app.get("/api/eventos", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    res.write(
        `data: ${JSON.stringify({ tipo: "conectado" })}\n\n`
    );

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
    const mensagem = JSON.stringify({
        tipo: "atualizacao",
        data: Date.now()
    });

    for (const cliente of [...clientes]) {
        try {
            cliente.write(`data: ${mensagem}\n\n`);
        } catch (_) {
            clientes.delete(cliente);
        }
    }
}

// ======================================================
// LISTAR VISITANTES
// ======================================================

app.get("/api/visitantes", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT *
            FROM pessoas
            ORDER BY nome ASC, id ASC
        `);

        res.setHeader("Cache-Control", "no-store");
        res.json(rows.map(linhaParaVisitante));
    } catch (erro) {
        console.error("Erro ao listar visitantes:", erro);
        res.status(500).json({
            erro: "Não foi possível carregar os visitantes."
        });
    }
});

// ======================================================
// CADASTRAR VISITANTE
// ======================================================

app.post("/api/visitantes", async (req, res) => {
    try {
        const nome = limparNome(req.body.nome);
        const cpf = limparCPF(req.body.cpf);

        if (!nome) {
            return res.status(400).json({ erro: "Informe o nome." });
        }

        if (cpf.length !== 11) {
            return res.status(400).json({
                erro: "CPF deve possuir 11 números."
            });
        }

        const duplicado = await pool.query(`
            SELECT 1
            FROM pessoas
            WHERE regexp_replace(cpf, '[^0-9]', '', 'g') = $1
            LIMIT 1
        `, [cpf]);

        if (duplicado.rowCount > 0) {
            return res.status(409).json({
                erro: "Este CPF já está cadastrado."
            });
        }

        const id = Date.now();
        const { rows } = await pool.query(`
            INSERT INTO pessoas
                (id, nome, cpf, entrou, horario, data_entrada, timestamp_entrada)
            VALUES ($1, $2, $3, FALSE, '', '', NULL)
            RETURNING *
        `, [id, nome, cpf]);

        const visitante = linhaParaVisitante(rows[0]);
        avisarTodos();
        res.status(201).json(visitante);
    } catch (erro) {
        if (erro.code === "23505") {
            return res.status(409).json({
                erro: "Este CPF já está cadastrado."
            });
        }

        console.error("Erro ao cadastrar visitante:", erro);
        res.status(500).json({
            erro: "Não foi possível cadastrar."
        });
    }
});

// ======================================================
// ALTERAR STATUS
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
                timestamp_entrada = CASE
                    WHEN $2 THEN $5::timestamptz
                    ELSE NULL
                END
            WHERE id::text = $1
            RETURNING *
        `, [id, entrou, momento.hora, momento.data, momento.iso]);

        if (!rows[0]) {
            return res.status(404).json({
                erro: "Visitante não encontrado."
            });
        }

        const visitante = linhaParaVisitante(rows[0]);
        avisarTodos();
        res.json(visitante);
    } catch (erro) {
        console.error("Erro ao alterar status:", erro);
        res.status(500).json({
            erro: "Não foi possível alterar o status."
        });
    }
});

// ======================================================
// EXPORTAR RELATÓRIO
// ======================================================

app.get("/exportar", async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT *
            FROM pessoas
            ORDER BY timestamp_entrada ASC NULLS LAST, nome ASC
        `);

        const visitantes = rows.map(linhaParaVisitante);
        const entraram = visitantes.filter(
            pessoa => pessoa.status === "entrou"
        );

        const agora = new Date();
        const formatar = new Intl.DateTimeFormat("pt-BR", {
            dateStyle: "short",
            timeStyle: "medium",
            timeZone: "America/Sao_Paulo"
        });

        const linhas = [];
        linhas.push("===============================================");
        linhas.push("          RELATÓRIO DE ENTRADAS");
        linhas.push("===============================================");
        linhas.push("");
        linhas.push(`Gerado em: ${formatar.format(agora)}`);
        linhas.push(`Total cadastrados: ${visitantes.length}`);
        linhas.push(`Total de entradas: ${entraram.length}`);
        linhas.push("");
        linhas.push("-----------------------------------------------");
        linhas.push("");

        entraram.forEach((pessoa, indice) => {
            let horario = "Horário não registrado";
            if (pessoa.entradaEm) {
                horario = formatar.format(new Date(pessoa.entradaEm));
            }
            linhas.push(`${indice + 1}. ${pessoa.nome}`);
            linhas.push(`CPF: ${pessoa.cpf}`);
            linhas.push(`Entrada: ${horario}`);
            linhas.push("");
        });

        const arquivo = "\uFEFF" + linhas.join("\r\n");
        const dataArquivo = agora.toISOString().slice(0, 10);

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="relatorio-${dataArquivo}.txt"`
        );
        res.send(arquivo);
    } catch (erro) {
        console.error("Erro ao exportar relatório:", erro);
        res.status(500).send("Não foi possível gerar o relatório.");
    }
});

// ======================================================
// SAÚDE DO SERVIÇO
// ======================================================

app.get("/health", async (req, res) => {
    try {
        const banco = await pool.query(
            "SELECT COUNT(*)::int AS total FROM pessoas"
        );
        res.json({
            ok: true,
            banco: "online",
            visitantes: banco.rows[0].total,
            frontend: fs.existsSync(path.join(PUBLIC_DIR, "index.html"))
        });
    } catch (erro) {
        res.status(503).json({
            ok: false,
            banco: "offline",
            erro: erro.message
        });
    }
});

// Mensagem clara caso o index.html não esteja no deploy.
app.get("/", (req, res, next) => {
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) {
        return res.sendFile(index);
    }
    next();
});

app.use((req, res) => {
    res.status(404).send("Página não encontrada.");
});

// ======================================================
// INICIA O SERVIDOR
// ======================================================

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
