import "dotenv/config";
import blessed from "blessed";
import figlet from "figlet";
import { ethers } from "ethers";
import axios from "axios";

const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = (await fs.readFile("keys.txt", "utf-8"))
  .replace(/\r/g, "")
  .split("\n")
  .filter(Boolean);
const WMON_ADDRESS = process.env.WMON_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const SMON_ADDRESS = process.env.SMON_ADDRESS;
const DAK_ADDRESS = process.env.DAK_ADDRESS;
const WMON_SWAP_ADDRESS = process.env.WMON_SWAP_ADDRESS;
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS;
const NETWORK_NAME = "CLOBER TESTNET";
const DEBUG_MODE = false;
const OPEN_OCEAN_API = "https://open-api.openocean.finance/v4/10143/swap";
const REFERRER = "0x331fa4a4f7b906491f37bdc8b042b894234e101f";

const ERC20ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
];

const WMON_ABI = [
  "function deposit() payable",
  "function withdraw(uint256 wad)",
];

const CLOBER_ABI = [
  "function swap(address inToken, address outToken, uint256 inAmount, address recipient, bytes data) payable",
];

const randomAmountRanges = {
  MON_WMON: { MON: { min: 0.1, max: 0.5 }, WMON: { min: 0.1, max: 0.5 } },
  MON_USDC: { MON: { min: 0.1, max: 0.5 }, USDC: { min: 0.3, max: 1.5 } },
  MON_sMON: { MON: { min: 0.1, max: 0.5 }, sMON: { min: 0.1, max: 0.5 } },
  MON_DAK: { MON: { min: 0.1, max: 0.5 }, DAK: { min: 0.3, max: 1.0 } },
};

let walletInfo = {
  address: "",
  balanceMon: "0.00",
  balanceWmon: "0.00",
  balanceUsdc: "0.00",
  balanceSmon: "0.00",
  balanceDak: "0.00",
  totalVolumeUsd: "0.00",
  leaderboardRank: "N/A",
  network: NETWORK_NAME,
  status: "Initializing",
};

let currentWallet = PRIVATE_KEY[0];
let transactionLogs = [];
let swapRunning = false;
let swapCancelled = false;
let globalWallet = null;
let provider = null;
let transactionQueue = Promise.resolve();
let transactionQueueList = [];
let transactionIdCounter = 0;
let nextNonce = null;
let lastSwapDirectionMonWmon = null;
let lastSwapDirectionMonUsdc = null;
let lastSwapDirectionMonSmon = null;
let lastSwapDirectionMonDak = null;

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function getShortHash(hash) {
  return hash && typeof hash === "string" && hash !== "0x"
    ? hash.slice(0, 6) + "..." + hash.slice(-4)
    : "Invalid Hash";
}

function addLog(message, type) {
  if (type === "debug" && !DEBUG_MODE) return;
  const timestamp = new Date().toLocaleTimeString();
  let coloredMessage = message;
  if (type === "swap")
    coloredMessage = `{bright-cyan-fg}${message}{/bright-cyan-fg}`;
  else if (type === "system")
    coloredMessage = `{bright-white-fg}${message}{/bright-white-fg}`;
  else if (type === "error")
    coloredMessage = `{bright-red-fg}${message}{/bright-red-fg}`;
  else if (type === "success")
    coloredMessage = `{bright-green-fg}${message}{/bright-green-fg}`;
  else if (type === "warning")
    coloredMessage = `{bright-yellow-fg}${message}{/bright-yellow-fg}`;
  else if (type === "debug")
    coloredMessage = `{bright-magenta-fg}${message}{/bright-magenta-fg}`;

  transactionLogs.push(
    `{bright-cyan-fg}[{/bright-cyan-fg} {bold}{grey-fg}${timestamp}{/grey-fg}{/bold} {bright-cyan-fg}]{/bright-cyan-fg} {bold}${coloredMessage}{/bold}`
  );
  updateLogs();
}

function getRandomDelay() {
  return Math.random() * (60000 - 30000) + 30000;
}

function getRandomDelayPerWallet() {
  return Math.random() * (180000 - 120000) + 120000;
}

function getRandomNumber(min, max) {
  return Math.random() * (max - min) + min;
}

function updateLogs() {
  logsBox.setContent(transactionLogs.join("\n"));
  logsBox.setScrollPerc(100);
  safeRender();
}

function clearTransactionLogs() {
  transactionLogs = [];
  logsBox.setContent("");
  logsBox.setScroll(0);
  updateLogs();
  safeRender();
  addLog("Transaction logs telah dihapus.", "system");
}

async function waitWithCancel(delay, type) {
  return Promise.race([
    new Promise((resolve) => setTimeout(resolve, delay)),
    new Promise((resolve) => {
      const interval = setInterval(() => {
        if (type === "swap" && swapCancelled) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    }),
  ]);
}

async function fetchLeaderboardData(walletAddress) {
  try {
    const response = await axios.get(
      `https://alpha.clober.io/api/chains/10143/leaderboard/user-address/${walletAddress}`
    );
    if (response.status === 200 && response.data.my_rank) {
      walletInfo.totalVolumeUsd = parseFloat(
        response.data.my_rank.total_volume_usd
      ).toFixed(2);
      walletInfo.leaderboardRank = response.data.my_rank.rank.toString();
    } else {
      throw new Error("Invalid leaderboard response");
    }
  } catch (error) {
    walletInfo.totalVolumeUsd = "0.00";
    walletInfo.leaderboardRank = "N/A";
    addLog(`Gagal mengambil data leaderboard: ${error.message}`, "error");
  }
}

async function addTransactionToQueue(
  transactionFunction,
  description = "Transaksi"
) {
  const transactionId = ++transactionIdCounter;
  transactionQueueList.push({
    id: transactionId,
    description,
    timestamp: new Date().toLocaleTimeString(),
    status: "queued",
  });
  addLog(
    `Transaksi [${transactionId}] ditambahkan ke antrean: ${description}`,
    "system"
  );
  updateQueueDisplay();

  transactionQueue = transactionQueue.then(async () => {
    updateTransactionStatus(transactionId, "processing");
    try {
      if (nextNonce === null) {
        nextNonce = await provider.getTransactionCount(
          globalWallet.address,
          "pending"
        );
        addLog(`Nonce awal: ${nextNonce}`, "debug");
      }
      const tx = await transactionFunction(nextNonce);
      const txHash = tx.hash;
      const receipt = await tx.wait();
      nextNonce++;
      if (receipt.status === 1) {
        updateTransactionStatus(transactionId, "completed");
        addLog(
          `Transaksi [${transactionId}] Selesai. Hash: ${getShortHash(
            receipt.transactionHash || txHash
          )}`,
          "debug"
        );
      } else {
        updateTransactionStatus(transactionId, "failed");
        addLog(
          `Transaksi [${transactionId}] gagal: Transaksi ditolak oleh kontrak.`,
          "error"
        );
      }
      return { receipt, txHash, tx };
    } catch (error) {
      updateTransactionStatus(transactionId, "error");
      let errorMessage = error.message;
      if (error.code === "CALL_EXCEPTION") {
        errorMessage = `Transaksi ditolak oleh kontrak: ${
          error.reason || "Alasan tidak diketahui"
        }`;
      }
      addLog(`Transaksi [${transactionId}] gagal: ${errorMessage}`, "error");
      if (error.message.includes("nonce has already been used")) {
        nextNonce++;
        addLog(
          `Nonce diincrement karena sudah digunakan. Nilai nonce baru: ${nextNonce}`,
          "system"
        );
      }
      return null;
    } finally {
      removeTransactionFromQueue(transactionId);
      updateQueueDisplay();
    }
  });
  return transactionQueue;
}

function updateTransactionStatus(id, status) {
  transactionQueueList.forEach((tx) => {
    if (tx.id === id) tx.status = status;
  });
  updateQueueDisplay();
}

function removeTransactionFromQueue(id) {
  transactionQueueList = transactionQueueList.filter((tx) => tx.id !== id);
  updateQueueDisplay();
}

function getTransactionQueueContent() {
  if (transactionQueueList.length === 0)
    return "Tidak ada transaksi dalam antrean.";
  return transactionQueueList
    .map(
      (tx) =>
        `ID: ${tx.id} | ${tx.description} | ${tx.status} | ${tx.timestamp}`
    )
    .join("\n");
}

let queueMenuBox = null;
let queueUpdateInterval = null;

function showTransactionQueueMenu() {
  const container = blessed.box({
    label: " Antrian Transaksi ",
    top: "10%",
    left: "center",
    width: "80%",
    height: "80%",
    border: { type: "line" },
    style: { border: { fg: "blue" } },
    keys: true,
    mouse: true,
    interactive: true,
  });
  const contentBox = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: "90%",
    content: getTransactionQueueContent(),
    scrollable: true,
    keys: true,
    mouse: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  });
  const exitButton = blessed.button({
    content: " [Keluar] ",
    bottom: 0,
    left: "center",
    shrink: true,
    padding: { left: 1, right: 1 },
    style: { fg: "white", bg: "red", hover: { bg: "blue" } },
    mouse: true,
    keys: true,
    interactive: true,
  });
  exitButton.on("press", () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.key(["a", "s", "d"], () => {
    addLog("Keluar Dari Menu Antrian Transaksi.", "system");
    clearInterval(queueUpdateInterval);
    container.destroy();
    queueMenuBox = null;
    mainMenu.show();
    mainMenu.focus();
    screen.render();
  });
  container.append(contentBox);
  container.append(exitButton);
  queueUpdateInterval = setInterval(() => {
    contentBox.setContent(getTransactionQueueContent());
    screen.render();
  }, 1000);
  mainMenu.hide();
  screen.append(container);
  container.focus();
  screen.render();
}

function updateQueueDisplay() {
  if (queueMenuBox) {
    queueMenuBox.setContent(getTransactionQueueContent());
    screen.render();
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "Clober Swap",
  fullUnicode: true,
  mouse: true,
});

let renderTimeout;

function safeRender() {
  if (renderTimeout) clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => {
    screen.render();
  }, 50);
}

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  tags: true,
  style: { fg: "white", bg: "default" },
});

figlet.text(
  "NT EXHAUST".toUpperCase(),
  { font: "ANSI Shadow" },
  (err, data) => {
    if (err) headerBox.setContent("{center}{bold}NT Exhaust{/bold}{/center}");
    else
      headerBox.setContent(
        `{center}{bold}{bright-cyan-fg}${data}{/bright-cyan-fg}{/bold}{/center}`
      );
    safeRender();
  }
);

const descriptionBox = blessed.box({
  left: "center",
  width: "100%",
  content:
    "{center}{bold}{bright-yellow-fg}✦ ✦ CLOBER AUTO SWAP ✦ ✦{/bright-yellow-fg}{/bold}{/center}",
  tags: true,
  style: { fg: "white", bg: "default" },
});

const logsBox = blessed.box({
  label: " Transaction Logs ",
  left: 0,
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  keys: true,
  vi: true,
  tags: true,
  style: { border: { fg: "red" }, fg: "white" },
  scrollbar: { ch: " ", inverse: true, style: { bg: "blue" } },
  content: "",
});

const walletBox = blessed.box({
  label: " Informasi Wallet ",
  border: { type: "line" },
  tags: true,
  style: { border: { fg: "magenta" }, fg: "white", bg: "default" },
  content: "Loading data wallet...",
});

const mainMenu = blessed.list({
  label: " Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "red" },
    selected: { bg: "green", fg: "black" },
  },
  items: getMainMenuItems(),
});

function getMainMenuItems() {
  let items = [];
  if (swapRunning) items.push("Stop Transaction");
  items = items.concat([
    "Clober Swap",
    "Antrian Transaksi",
    "Clear Transaction Logs",
    "Refresh",
    "Exit",
  ]);
  return items;
}

function getCloberSwapMenuItems() {
  let items = [];
  if (swapRunning) items.push("Stop Transaction");
  items = items.concat([
    "Auto Swap MON & WMON",
    "Auto Swap MON & USDC",
    "Auto Swap MON & sMON",
    "Auto Swap MON & DAK",
    "Change Random Amount",
    "Clear Transaction Logs",
    "Back To Main Menu",
    "Refresh",
  ]);
  return items;
}

const cloberSwapSubMenu = blessed.list({
  label: " Clober Swap Sub Menu ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "red" },
    selected: { bg: "cyan", fg: "black" },
  },
  items: getCloberSwapMenuItems(),
});
cloberSwapSubMenu.hide();

const changeRandomAmountSubMenu = blessed.list({
  label: " Change Random Amount ",
  left: "60%",
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "red" },
    selected: { bg: "cyan", fg: "black" },
  },
  items: [
    "MON & WMON",
    "MON & USDC",
    "MON & sMON",
    "MON & DAK",
    "Back To Clober Swap Menu",
  ], // Added MON & DAK
});
changeRandomAmountSubMenu.hide();

const promptBox = blessed.prompt({
  parent: screen,
  border: "line",
  height: 5,
  width: "60%",
  top: "center",
  left: "center",
  label: "{bright-blue-fg}Prompt{/bright-blue-fg}",
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  style: { fg: "bright-red", bg: "default", border: { fg: "red" } },
});

screen.append(headerBox);
screen.append(descriptionBox);
screen.append(logsBox);
screen.append(walletBox);
screen.append(mainMenu);
screen.append(cloberSwapSubMenu);
screen.append(changeRandomAmountSubMenu);

function adjustLayout() {
  const screenHeight = screen.height;
  const screenWidth = screen.width;
  const headerHeight = Math.max(8, Math.floor(screenHeight * 0.15));
  headerBox.top = 0;
  headerBox.height = headerHeight;
  headerBox.width = "100%";
  descriptionBox.top = "22%";
  descriptionBox.height = Math.floor(screenHeight * 0.05);
  logsBox.top = headerHeight + descriptionBox.height;
  logsBox.left = 0;
  logsBox.width = Math.floor(screenWidth * 0.6);
  logsBox.height = screenHeight - (headerHeight + descriptionBox.height);
  walletBox.top = headerHeight + descriptionBox.height;
  walletBox.left = Math.floor(screenWidth * 0.6);
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  mainMenu.top = headerHeight + descriptionBox.height + walletBox.height;
  mainMenu.left = Math.floor(screenWidth * 0.6);
  mainMenu.width = Math.floor(screenWidth * 0.4);
  mainMenu.height =
    screenHeight - (headerHeight + descriptionBox.height + walletBox.height);
  cloberSwapSubMenu.top = mainMenu.top;
  cloberSwapSubMenu.left = mainMenu.left;
  cloberSwapSubMenu.width = mainMenu.width;
  cloberSwapSubMenu.height = mainMenu.height;
  changeRandomAmountSubMenu.top = mainMenu.top;
  changeRandomAmountSubMenu.left = mainMenu.left;
  changeRandomAmountSubMenu.width = mainMenu.width;
  changeRandomAmountSubMenu.height = mainMenu.height;
  safeRender();
}

screen.on("resize", adjustLayout);
adjustLayout();

async function getTokenBalance(tokenAddress) {
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20ABI, provider);
    const balance = await contract.balanceOf(globalWallet.address);
    const decimals = await contract.decimals();
    return ethers.formatUnits(balance, decimals);
  } catch (error) {
    addLog(
      `Gagal mengambil saldo token ${tokenAddress}: ${error.message}`,
      "error"
    );
    return "0";
  }
}

async function updateWalletData() {
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(currentWallet, provider);
    globalWallet = wallet;
    walletInfo.address = wallet.address;

    const monBalance = await provider.getBalance(wallet.address);
    walletInfo.balanceMon = ethers.formatEther(monBalance);

    walletInfo.balanceWmon = await getTokenBalance(WMON_ADDRESS);
    walletInfo.balanceUsdc = await getTokenBalance(USDC_ADDRESS);
    walletInfo.balanceSmon = await getTokenBalance(SMON_ADDRESS);
    walletInfo.balanceDak = await getTokenBalance(DAK_ADDRESS);
    await fetchLeaderboardData(wallet.address);
    updateWallet();
    addLog("Wallet Information Updated !!", "system");
  } catch (error) {
    addLog("Gagal mengambil data wallet: " + error.message, "system");
  }
}

function updateWallet() {
  const shortAddress = walletInfo.address
    ? getShortAddress(walletInfo.address)
    : "N/A";
  const mon = walletInfo.balanceMon
    ? Number(walletInfo.balanceMon).toFixed(4)
    : "0.0000";
  const wmon = walletInfo.balanceWmon
    ? Number(walletInfo.balanceWmon).toFixed(4)
    : "0.0000";
  const usdc = walletInfo.balanceUsdc
    ? Number(walletInfo.balanceUsdc).toFixed(2)
    : "0.00";
  const smon = walletInfo.balanceSmon
    ? Number(walletInfo.balanceSmon).toFixed(4)
    : "0.0000";
  const dak = walletInfo.balanceDak
    ? Number(walletInfo.balanceDak).toFixed(4)
    : "0.0000";
  const totalVolume = walletInfo.totalVolumeUsd
    ? walletInfo.totalVolumeUsd
    : "0.00";
  const rank = walletInfo.leaderboardRank ? walletInfo.leaderboardRank : "N/A";

  const content = `┌── Address   : {bright-yellow-fg}${shortAddress}{/bright-yellow-fg}
│   ├── MON        : {bright-green-fg}${mon}{/bright-green-fg}
│   ├── WMON       : {bright-green-fg}${wmon}{/bright-green-fg}
│   ├── USDC       : {bright-green-fg}${usdc}{/bright-green-fg}
│   ├── sMON       : {bright-green-fg}${smon}{/bright-green-fg}
│   ├── DAK        : {bright-green-fg}${dak}{/bright-green-fg}
│   ├── Total Vol  : {bright-cyan-fg}${totalVolume} USD{/bright-cyan-fg}
│   └── Rank       : {bright-cyan-fg}${rank}{/bright-cyan-fg}
└── Network        : {bright-cyan-fg}${NETWORK_NAME}{/bright-cyan-fg}`;
  walletBox.setContent(content);
  safeRender();
}

async function autoSwapMonWmon() {
  const direction =
    lastSwapDirectionMonWmon === "MON_TO_WMON" ? "WMON_TO_MON" : "MON_TO_WMON";
  lastSwapDirectionMonWmon = direction;

  const ranges = randomAmountRanges["MON_WMON"];
  const amount =
    direction === "MON_TO_WMON"
      ? getRandomNumber(ranges.MON.min, ranges.MON.max).toFixed(6)
      : getRandomNumber(ranges.WMON.min, ranges.WMON.max).toFixed(6);
  const swapContract = new ethers.Contract(
    WMON_SWAP_ADDRESS,
    WMON_ABI,
    globalWallet
  );
  const wmonContract = new ethers.Contract(
    WMON_ADDRESS,
    ERC20ABI,
    globalWallet
  );
  const decimals = await wmonContract.decimals();
  const amountWei = ethers.parseUnits(amount, decimals);

  if (direction === "MON_TO_WMON") {
    const monBalance = await provider.getBalance(globalWallet.address);
    if (parseFloat(ethers.formatEther(monBalance)) < parseFloat(amount)) {
      addLog(
        `Insufficient MON balance: ${ethers.formatEther(
          monBalance
        )} < ${amount}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amount} MON ➯ WMON`, "swap");

    let txParams = { value: amountWei, nonce: null };
    try {
      const gasLimit = await swapContract.estimateGas.deposit({
        value: amountWei,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal untuk deposit: ${error.message}. Menggunakan gas default jaringan.`,
        "debug"
      );
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapContract.deposit(txParams);
      addLog(
        `Tx Sent ${amount} MON ➯ WMON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amount} MON to WMON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amount} MON ➯ WMON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap MON to WMON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  } else {
    const wmonBalance = await getTokenBalance(WMON_ADDRESS);
    if (parseFloat(wmonBalance) < parseFloat(amount)) {
      addLog(
        `Insufficient WMON balance: ${wmonBalance} < ${amount}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amount} WMON ➯ MON`, "swap");

    const allowance = await wmonContract.allowance(
      globalWallet.address,
      WMON_SWAP_ADDRESS
    );
    if (allowance < amountWei) {
      addLog(`Requesting Approval untuk ${amount} WMON.`, "swap");
      let approveTxParams = { nonce: null };
      try {
        const approveGasLimit = await wmonContract.estimateGas.approve(
          WMON_SWAP_ADDRESS,
          amountWei
        );
        approveTxParams.gasLimit =
          (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(
          `Estimasi gas untuk approve: ${approveTxParams.gasLimit}`,
          "debug"
        );
      } catch (error) {
        addLog(
          `Gas estimasi gagal untuk approve: ${error.message}. Menggunakan gas default jaringan.`,
          "debug"
        );
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await wmonContract.approve(
          WMON_SWAP_ADDRESS,
          amountWei,
          approveTxParams
        );
        addLog(`Approval transaction sent.`, "swap");
        return tx;
      };
      const result = await addTransactionToQueue(
        approveTxFunction,
        `Approve ${amount} WMON`
      );
      if (!result || !result.receipt || result.receipt.status !== 1) {
        addLog(`Approval gagal untuk WMON. Membatalkan swap.`, "error");
        return false;
      }
      addLog(`Approval Berhasil ${amount} WMON.`, "swap");
    }

    let txParams = { nonce: null };
    try {
      const gasLimit = await swapContract.estimateGas.withdraw(amountWei);
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal untuk withdraw: ${error.message}. Menggunakan gas default jaringan.`,
        "debug"
      );
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await swapContract.withdraw(amountWei, txParams);
      addLog(
        `Tx Sent ${amount} WMON ➯ MON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amount} WMON to MON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amount} WMON ➯ MON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap WMON to MON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  }
}

async function autoSwapMonUsdc() {
  const direction =
    lastSwapDirectionMonUsdc === "MON_TO_USDC" ? "USDC_TO_MON" : "MON_TO_USDC";
  lastSwapDirectionMonUsdc = direction;

  const ranges = randomAmountRanges["MON_USDC"];
  const usdcContract = new ethers.Contract(
    USDC_ADDRESS,
    ERC20ABI,
    globalWallet
  );
  const usdcDecimals = await usdcContract.decimals();

  const swapInterface = new ethers.Interface(CLOBER_ABI);

  if (direction === "MON_TO_USDC") {
    const amountMon = getRandomNumber(ranges.MON.min, ranges.MON.max).toFixed(
      6
    );
    const monBalance = await provider.getBalance(globalWallet.address);
    if (parseFloat(ethers.formatEther(monBalance)) < parseFloat(amountMon)) {
      addLog(
        `Insufficient MON balance: ${ethers.formatEther(
          monBalance
        )} < ${amountMon}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountMon} MON ➯ USDC`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: "0x0000000000000000000000000000000000000000",
          outTokenAddress: USDC_ADDRESS,
          amount: amountMon,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatUnits(
          swapData.outAmount,
          usdcDecimals
        )} USDC untuk ${amountMon} MON`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = "0x0000000000000000000000000000000000000000";
    const outToken = USDC_ADDRESS;
    const inAmount = ethers.parseEther(amountMon);
    const recipient = swapData.to;
    const data = swapData.data;

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: inAmount,
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 52000`,
        "debug"
      );
      txParams.gasLimit = 52000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          usdcDecimals
        )} USDC, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountMon} MON to USDC`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          usdcDecimals
        )} USDC, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap MON to USDC. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  } else {
    const amountUsdc = getRandomNumber(
      ranges.USDC.min,
      ranges.USDC.max
    ).toFixed(6);
    const usdcBalance = await getTokenBalance(USDC_ADDRESS);
    if (parseFloat(usdcBalance) < parseFloat(amountUsdc)) {
      addLog(
        `Insufficient USDC balance: ${usdcBalance} < ${amountUsdc}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountUsdc} USDC ➯ MON`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: USDC_ADDRESS,
          outTokenAddress: "0x0000000000000000000000000000000000000000",
          amount: amountUsdc,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatEther(
          swapData.outAmount
        )} MON untuk ${amountUsdc} USDC`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = USDC_ADDRESS;
    const outToken = "0x0000000000000000000000000000000000000000";
    const inAmount = ethers.parseUnits(amountUsdc, usdcDecimals);
    const recipient = swapData.to;
    const data = swapData.data;

    const allowance = await usdcContract.allowance(
      globalWallet.address,
      ROUTER_ADDRESS
    );
    if (allowance < inAmount) {
      addLog(`Requesting Approval untuk ${amountUsdc} USDC.`, "swap");
      let approveTxParams = { nonce: null };
      try {
        const approveGasLimit = await usdcContract.estimateGas.approve(
          ROUTER_ADDRESS,
          inAmount
        );
        approveTxParams.gasLimit =
          (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Estimasi gas: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(
          `Gas estimasi gagal: ${error.message}. Menggunakan gas default 100,000.`,
          "debug"
        );
        approveTxParams.gasLimit = 100000;
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await usdcContract.approve(
          ROUTER_ADDRESS,
          inAmount,
          approveTxParams
        );
        addLog(`Approval transaction sent.`, "swap");
        return tx;
      };
      const result = await addTransactionToQueue(
        approveTxFunction,
        `Approve ${amountUsdc} USDC`
      );
      if (!result || !result.receipt || result.receipt.status !== 1) {
        addLog(`Approval gagal untuk USDC. Membatalkan swap.`, "error");
        return false;
      }
      addLog(`Approval Berhasil ${amountUsdc} USDC.`, "swap");
    }

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: ethers.parseUnits(swapData.value || "0", "wei"),
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 50000.`,
        "debug"
      );
      txParams.gasLimit = 50000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountUsdc} USDC ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountUsdc} USDC to MON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountUsdc} USDC ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap USDC to MON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  }
}

async function autoSwapMonSmon() {
  const direction =
    lastSwapDirectionMonSmon === "MON_TO_sMON" ? "sMON_TO_MON" : "MON_TO_sMON";
  lastSwapDirectionMonSmon = direction;

  const ranges = randomAmountRanges["MON_sMON"];
  const smonContract = new ethers.Contract(
    SMON_ADDRESS,
    ERC20ABI,
    globalWallet
  );
  const smonDecimals = await smonContract.decimals();

  const swapInterface = new ethers.Interface(CLOBER_ABI);

  if (direction === "MON_TO_sMON") {
    const amountMon = getRandomNumber(ranges.MON.min, ranges.MON.max).toFixed(
      6
    );
    const monBalance = await provider.getBalance(globalWallet.address);
    if (parseFloat(ethers.formatEther(monBalance)) < parseFloat(amountMon)) {
      addLog(
        `Insufficient MON balance: ${ethers.formatEther(
          monBalance
        )} < ${amountMon}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountMon} MON ➯ sMON`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: "0x0000000000000000000000000000000000000000",
          outTokenAddress: SMON_ADDRESS,
          amount: amountMon,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatUnits(
          swapData.outAmount,
          smonDecimals
        )} sMON untuk ${amountMon} MON`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = "0x0000000000000000000000000000000000000000";
    const outToken = SMON_ADDRESS;
    const inAmount = ethers.parseEther(amountMon);
    const recipient = swapData.to;
    const data = swapData.data;

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: inAmount,
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 50000.`,
        "debug"
      );
      txParams.gasLimit = 50000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          smonDecimals
        )} sMON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountMon} MON to sMON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          smonDecimals
        )} sMON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap MON to sMON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  } else {
    const amountSmon = getRandomNumber(
      ranges.sMON.min,
      ranges.sMON.max
    ).toFixed(6);
    const smonBalance = await getTokenBalance(SMON_ADDRESS);
    if (parseFloat(smonBalance) < parseFloat(amountSmon)) {
      addLog(
        `Insufficient sMON balance: ${smonBalance} < ${amountSmon}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountSmon} sMON ➯ MON`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: SMON_ADDRESS,
          outTokenAddress: "0x0000000000000000000000000000000000000000",
          amount: amountSmon,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatEther(
          swapData.outAmount
        )} MON untuk ${amountSmon} sMON`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = SMON_ADDRESS;
    const outToken = "0x0000000000000000000000000000000000000000";
    const inAmount = ethers.parseUnits(amountSmon, smonDecimals);
    const recipient = swapData.to;
    const data = swapData.data;

    const allowance = await smonContract.allowance(
      globalWallet.address,
      ROUTER_ADDRESS
    );
    if (allowance < inAmount) {
      addLog(`Requesting Approval untuk ${amountSmon} sMON.`, "swap");
      let approveTxParams = { nonce: null };
      try {
        const approveGasLimit = await smonContract.estimateGas.approve(
          ROUTER_ADDRESS,
          inAmount
        );
        approveTxParams.gasLimit =
          (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Estimasi gas: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(
          `Gas estimasi gagal: ${error.message}. Menggunakan gas default 100,000.`,
          "debug"
        );
        approveTxParams.gasLimit = 100000;
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await smonContract.approve(
          ROUTER_ADDRESS,
          inAmount,
          approveTxParams
        );
        addLog(`Approval transaction sent.`, "swap");
        return tx;
      };
      const result = await addTransactionToQueue(
        approveTxFunction,
        `Approve ${amountSmon} sMON`
      );
      if (!result || !result.receipt || result.receipt.status !== 1) {
        addLog(`Approval gagal untuk sMON. Membatalkan swap.`, "error");
        return false;
      }
      addLog(`Approval Berhasil ${amountSmon} sMON.`, "swap");
    }

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: ethers.parseUnits(swapData.value || "0", "wei"),
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 50000.`,
        "debug"
      );
      txParams.gasLimit = 50000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountSmon} sMON ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountSmon} sMON to MON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountSmon} sMON ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap sMON to MON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  }
}

async function autoSwapMonDak() {
  const direction =
    lastSwapDirectionMonDak === "MON_TO_DAK" ? "DAK_TO_MON" : "MON_TO_DAK";
  lastSwapDirectionMonDak = direction;

  const ranges = randomAmountRanges["MON_DAK"];
  const dakContract = new ethers.Contract(DAK_ADDRESS, ERC20ABI, globalWallet);
  const dakDecimals = await dakContract.decimals();

  const swapInterface = new ethers.Interface(CLOBER_ABI);

  if (direction === "MON_TO_DAK") {
    const amountMon = getRandomNumber(ranges.MON.min, ranges.MON.max).toFixed(
      6
    );
    const monBalance = await provider.getBalance(globalWallet.address);
    if (parseFloat(ethers.formatEther(monBalance)) < parseFloat(amountMon)) {
      addLog(
        `Insufficient MON balance: ${ethers.formatEther(
          monBalance
        )} < ${amountMon}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountMon} MON ➯ DAK`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: "0x0000000000000000000000000000000000000000",
          outTokenAddress: DAK_ADDRESS,
          amount: amountMon,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatUnits(
          swapData.outAmount,
          dakDecimals
        )} DAK untuk ${amountMon} MON`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = "0x0000000000000000000000000000000000000000";
    const outToken = DAK_ADDRESS;
    const inAmount = ethers.parseEther(amountMon);
    const recipient = swapData.to;
    const data = swapData.data;

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: inAmount,
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 50000.`,
        "debug"
      );
      txParams.gasLimit = 50000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          dakDecimals
        )} DAK, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountMon} MON to DAK`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountMon} MON ➯ ${ethers.formatUnits(
          swapData.outAmount,
          dakDecimals
        )} DAK, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap MON to DAK. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  } else {
    const amountDak = getRandomNumber(ranges.DAK.min, ranges.DAK.max).toFixed(
      6
    );
    const dakBalance = await getTokenBalance(DAK_ADDRESS);
    if (parseFloat(dakBalance) < parseFloat(amountDak)) {
      addLog(
        `Insufficient DAK balance: ${dakBalance} < ${amountDak}`,
        "warning"
      );
      return false;
    }

    addLog(`Melakukan Swap ${amountDak} DAK ➯ MON`, "swap");

    let swapData;
    try {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const response = await axios.get(OPEN_OCEAN_API, {
        params: {
          inTokenAddress: DAK_ADDRESS,
          outTokenAddress: "0x0000000000000000000000000000000000000000",
          amount: amountDak,
          gasPrice: "52000000000",
          slippage: 1,
          account: globalWallet.address,
          referrer: REFERRER,
        },
      });
      if (response.data.code !== 200) {
        addLog(
          `Gagal mendapatkan data swap dari API: ${
            response.data.message || "Unknown error"
          }`,
          "error"
        );
        return false;
      }
      swapData = response.data.data;
      addLog(
        `API Response: Mendapatkan ${ethers.formatEther(
          swapData.outAmount
        )} MON untuk ${amountDak} DAK`,
        "debug"
      );
    } catch (error) {
      addLog(`Gagal memanggil API OpenOcean: ${error.message}`, "error");
      return false;
    }

    const inToken = DAK_ADDRESS;
    const outToken = "0x0000000000000000000000000000000000000000";
    const inAmount = ethers.parseUnits(amountDak, dakDecimals);
    const recipient = swapData.to;
    const data = swapData.data;

    const allowance = await dakContract.allowance(
      globalWallet.address,
      ROUTER_ADDRESS
    );
    if (allowance < inAmount) {
      addLog(`Requesting Approval untuk ${amountDak} DAK.`, "swap");
      let approveTxParams = { nonce: null };
      try {
        const approveGasLimit = await dakContract.estimateGas.approve(
          ROUTER_ADDRESS,
          inAmount
        );
        approveTxParams.gasLimit =
          (approveGasLimit * BigInt(120)) / BigInt(100);
        addLog(`Estimasi gas: ${approveTxParams.gasLimit}`, "debug");
      } catch (error) {
        addLog(
          `Gas estimasi gagal: ${error.message}. Menggunakan gas default 100,000.`,
          "debug"
        );
        approveTxParams.gasLimit = 100000;
      }
      const approveTxFunction = async (nonce) => {
        approveTxParams.nonce = nonce;
        const tx = await dakContract.approve(
          ROUTER_ADDRESS,
          inAmount,
          approveTxParams
        );
        addLog(`Approval transaction sent.`, "swap");
        return tx;
      };
      const result = await addTransactionToQueue(
        approveTxFunction,
        `Approve ${amountDak} DAK`
      );
      if (!result || !result.receipt || result.receipt.status !== 1) {
        addLog(`Approval gagal untuk DAK. Membatalkan swap.`, "error");
        return false;
      }
      addLog(`Approval Berhasil ${amountDak} DAK.`, "swap");
    }

    const callData = swapInterface.encodeFunctionData("swap", [
      inToken,
      outToken,
      inAmount,
      recipient,
      data,
    ]);

    let txParams = {
      to: ROUTER_ADDRESS,
      data: callData,
      value: ethers.parseUnits(swapData.value || "0", "wei"),
      nonce: null,
    };

    try {
      const gasLimit = await provider.estimateGas({
        ...txParams,
        from: globalWallet.address,
      });
      txParams.gasLimit = (gasLimit * BigInt(120)) / BigInt(100);
      addLog(`Estimasi gas: ${txParams.gasLimit}`, "debug");
    } catch (error) {
      addLog(
        `Gas estimasi gagal: ${error.message}. Menggunakan gas default 50000.`,
        "debug"
      );
      txParams.gasLimit = 50000;
    }

    const swapTxFunction = async (nonce) => {
      txParams.nonce = nonce;
      const tx = await globalWallet.sendTransaction(txParams);
      addLog(
        `Tx Sent ${amountDak} DAK ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(tx.hash)}`,
        "swap"
      );
      return tx;
    };

    const result = await addTransactionToQueue(
      swapTxFunction,
      `Swap ${amountDak} DAK to MON`
    );

    if (result && result.receipt && result.receipt.status === 1) {
      addLog(
        `Swap Berhasil ${amountDak} DAK ➯ ${ethers.formatEther(
          swapData.outAmount
        )} MON, Hash: ${getShortHash(
          result.receipt.transactionHash || result.txHash
        )}`,
        "success"
      );
      return true;
    } else {
      addLog(
        `Gagal swap DAK to MON. Transaksi mungkin gagal atau tertunda.`,
        "error"
      );
      return false;
    }
  }
}

async function runAutoSwapMonWmon() {
  promptBox.setFront();
  promptBox.readInput(
    "Masukkan jumlah swap MON & WMON",
    "",
    async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Clober Swap: Input tidak valid atau dibatalkan.", "swap");
        return;
      }
      const loopCount = parseInt(value);
      if (isNaN(loopCount)) {
        addLog("Clober Swap: Input harus berupa angka.", "swap");
        return;
      }
      addLog(
        `Clober Swap: Mulai ${loopCount} iterasi swap MON & WMON.`,
        "swap"
      );

      let j = 1;

      for (const key of PRIVATE_KEY) {
        nextNonce = null;
        swapRunning = true;
        swapCancelled = false;
        mainMenu.setItems(getMainMenuItems());
        cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
        cloberSwapSubMenu.show();
        safeRender();

        currentWallet = key;

        await updateWalletData();

        let i = 1;

        for (i; i <= loopCount; i++) {
          if (swapCancelled) {
            addLog(
              `Clober Swap: Auto Swap MON & WMON Dihentikan pada Cycle ${i}.`,
              "swap"
            );
            break;
          }
          addLog(
            `Memulai swap ke-${i}: Arah ${
              lastSwapDirectionMonWmon === "MON_TO_WMON"
                ? "WMON_TO_MON"
                : "MON_TO_WMON"
            }`,
            "swap"
          );
          const success = await autoSwapMonWmon();
          if (success) {
            await updateWalletData();
          }
          if (i < loopCount) {
            const delayTime = getRandomDelay();
            const minutes = Math.floor(delayTime / 60000);
            const seconds = Math.floor((delayTime % 60000) / 1000);
            addLog(
              `Swap ke-${i} selesai. Menunggu ${minutes} menit ${seconds} detik.`,
              "swap"
            );
            await waitWithCancel(delayTime, "swap");
            if (swapCancelled) {
              addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
              break;
            }
          }
        }

        if (j < PRIVATE_KEY.length) {
          const delayTime = getRandomDelayPerWallet();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(
            `Persiapan pindah ke wallet berikutnya. Menunggu ${minutes} menit ${seconds} detik.`,
            "system"
          );
          await waitWithCancel(delayTime, "swap");
          if (swapCancelled) {
            addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
            break;
          }
        }

        j++;
      }

      swapRunning = false;
      mainMenu.setItems(getMainMenuItems());
      cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
      safeRender();
      addLog("Clober Swap: Auto Swap MON & WMON selesai.", "swap");
    }
  );
}

async function runAutoSwapMonUsdc() {
  promptBox.setFront();
  promptBox.readInput(
    "Masukkan jumlah swap MON & USDC",
    "",
    async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Clober Swap: Input tidak valid atau dibatalkan.", "swap");
        return;
      }
      const loopCount = parseInt(value);
      if (isNaN(loopCount)) {
        addLog("Clober Swap: Input harus berupa angka.", "swap");
        return;
      }
      addLog(
        `Clober Swap: Mulai ${loopCount} iterasi swap MON & USDC.`,
        "swap"
      );

      let j = 1;

      for (const key of PRIVATE_KEY) {
        nextNonce = null;
        swapRunning = true;
        swapCancelled = false;
        mainMenu.setItems(getMainMenuItems());
        cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
        cloberSwapSubMenu.show();
        safeRender();

        currentWallet = key;

        await updateWalletData();

        let i = 1;

        for (i; i <= loopCount; i++) {
          if (swapCancelled) {
            addLog(
              `Clober Swap: Auto Swap MON & USDC Dihentikan pada Cycle ${i}.`,
              "swap"
            );
            break;
          }
          addLog(
            `Memulai swap ke-${i}: Arah ${
              lastSwapDirectionMonUsdc === "MON_TO_USDC"
                ? "USDC_TO_MON"
                : "MON_TO_USDC"
            }`,
            "swap"
          );
          const success = await autoSwapMonUsdc();
          if (success) {
            await updateWalletData();
          }
          if (i < loopCount) {
            const delayTime = getRandomDelay();
            const minutes = Math.floor(delayTime / 60000);
            const seconds = Math.floor((delayTime % 60000) / 1000);
            addLog(
              `Swap ke-${i} selesai. Menunggu ${minutes} menit ${seconds} detik.`,
              "swap"
            );
            await waitWithCancel(delayTime, "swap");
            if (swapCancelled) {
              addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
              break;
            }
          }
        }

        if (j < PRIVATE_KEY.length) {
          const delayTime = getRandomDelayPerWallet();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(
            `Persiapan pindah ke wallet berikutnya. Menunggu ${minutes} menit ${seconds} detik.`,
            "system"
          );
          await waitWithCancel(delayTime, "swap");
          if (swapCancelled) {
            addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
            break;
          }
        }

        j++;
      }

      swapRunning = false;
      mainMenu.setItems(getMainMenuItems());
      cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
      safeRender();
      addLog("Clober Swap: Auto Swap MON & USDC selesai.", "swap");
    }
  );
}

async function runAutoSwapMonSmon() {
  promptBox.setFront();
  promptBox.readInput(
    "Masukkan jumlah swap MON & sMON",
    "",
    async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Clober Swap: Input tidak valid atau dibatalkan.", "swap");
        return;
      }
      const loopCount = parseInt(value);
      if (isNaN(loopCount)) {
        addLog("Clober Swap: Input harus berupa angka.", "swap");
        return;
      }
      addLog(
        `Clober Swap: Mulai ${loopCount} iterasi swap MON & sMON.`,
        "swap"
      );

      let j = 1;

      for (const key of PRIVATE_KEY) {
        nextNonce = null;
        swapRunning = true;
        swapCancelled = false;
        mainMenu.setItems(getMainMenuItems());
        cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
        cloberSwapSubMenu.show();
        safeRender();

        currentWallet = key;

        await updateWalletData();

        let i = 1;

        for (i; i <= loopCount; i++) {
          if (swapCancelled) {
            addLog(
              `Clober Swap: Auto Swap MON & sMON Dihentikan pada Cycle ${i}.`,
              "swap"
            );
            break;
          }
          addLog(
            `Memulai swap ke-${i}: Arah ${
              lastSwapDirectionMonSmon === "MON_TO_sMON"
                ? "sMON_TO_MON"
                : "MON_TO_sMON"
            }`,
            "swap"
          );
          const success = await autoSwapMonSmon();
          if (success) {
            await updateWalletData();
          }
          if (i < loopCount) {
            const delayTime = getRandomDelay();
            const minutes = Math.floor(delayTime / 60000);
            const seconds = Math.floor((delayTime % 60000) / 1000);
            addLog(
              `Swap ke-${i} selesai. Menunggu ${minutes} menit ${seconds} detik.`,
              "swap"
            );
            await waitWithCancel(delayTime, "swap");
            if (swapCancelled) {
              addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
              break;
            }
          }
        }

        if (j < PRIVATE_KEY.length) {
          const delayTime = getRandomDelayPerWallet();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(
            `Persiapan pindah ke wallet berikutnya. Menunggu ${minutes} menit ${seconds} detik.`,
            "system"
          );
          await waitWithCancel(delayTime, "swap");
          if (swapCancelled) {
            addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
            break;
          }
        }

        j++;
      }

      swapRunning = false;
      mainMenu.setItems(getMainMenuItems());
      cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
      safeRender();
      addLog("Clober Swap: Auto Swap MON & sMON selesai.", "swap");
    }
  );
}

async function runAutoSwapMonDak() {
  promptBox.setFront();
  promptBox.readInput(
    "Masukkan jumlah swap MON & DAK",
    "",
    async (err, value) => {
      promptBox.hide();
      safeRender();
      if (err || !value) {
        addLog("Clober Swap: Input tidak valid atau dibatalkan.", "swap");
        return;
      }
      const loopCount = parseInt(value);
      if (isNaN(loopCount)) {
        addLog("Clober Swap: Input harus berupa angka.", "swap");
        return;
      }
      addLog(`Clober Swap: Mulai ${loopCount} iterasi swap MON & DAK.`, "swap");

      let j = 1;

      for (const key of PRIVATE_KEY) {
        nextNonce = null;
        swapRunning = true;
        swapCancelled = false;
        mainMenu.setItems(getMainMenuItems());
        cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
        cloberSwapSubMenu.show();
        safeRender();

        currentWallet = key;

        await updateWalletData();

        let i = 1;

        for (i; i <= loopCount; i++) {
          if (swapCancelled) {
            addLog(
              `Clober Swap: Auto Swap MON & DAK Dihentikan pada Cycle ${i}.`,
              "swap"
            );
            break;
          }
          addLog(
            `Memulai swap ke-${i}: Arah ${
              lastSwapDirectionMonDak === "MON_TO_DAK"
                ? "DAK_TO_MON"
                : "MON_TO_DAK"
            }`,
            "swap"
          );
          const success = await autoSwapMonDak();
          if (success) {
            await updateWalletData();
          }
          if (i < loopCount) {
            const delayTime = getRandomDelay();
            const minutes = Math.floor(delayTime / 60000);
            const seconds = Math.floor((delayTime % 60000) / 1000);
            addLog(
              `Swap ke-${i} selesai. Menunggu ${minutes} menit ${seconds} detik.`,
              "swap"
            );
            await waitWithCancel(delayTime, "swap");
            if (swapCancelled) {
              addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
              break;
            }
          }
        }

        if (j < PRIVATE_KEY.length) {
          const delayTime = getRandomDelayPerWallet();
          const minutes = Math.floor(delayTime / 60000);
          const seconds = Math.floor((delayTime % 60000) / 1000);
          addLog(
            `Persiapan pindah ke wallet berikutnya. Menunggu ${minutes} menit ${seconds} detik.`,
            "system"
          );
          await waitWithCancel(delayTime, "swap");
          if (swapCancelled) {
            addLog("Clober Swap: Dihentikan saat periode tunggu.", "swap");
            break;
          }
        }

        j++;
      }

      swapRunning = false;
      mainMenu.setItems(getMainMenuItems());
      cloberSwapSubMenu.setItems(getCloberSwapMenuItems());
      safeRender();
      addLog("Clober Swap: Auto Swap MON & DAK selesai.", "swap");
    }
  );
}

function changeRandomAmount(pair) {
  const pairKey = pair.replace(" & ", "_");
  const token2 = pair.split(" & ")[1];
  promptBox.setFront();
  promptBox.input(
    `Masukkan rentang random amount untuk MON pada pasangan ${pair} (format: min,max, contoh: 0.1,0.5)`,
    "",
    (err, valueMon) => {
      promptBox.hide();
      safeRender();
      if (err || !valueMon) {
        addLog(
          `Change Random Amount: Input untuk MON pada ${pair} dibatalkan.`,
          "system"
        );
        changeRandomAmountSubMenu.show();
        changeRandomAmountSubMenu.focus();
        safeRender();
        return;
      }
      const [minMon, maxMon] = valueMon
        .split(",")
        .map((v) => parseFloat(v.trim()));
      if (isNaN(minMon) || isNaN(maxMon) || minMon <= 0 || maxMon <= minMon) {
        addLog(
          `Change Random Amount: Input tidak valid untuk MON pada ${pair}. Gunakan format min,max (contoh: 0.1,0.5) dengan min > 0 dan max > min.`,
          "error"
        );
        changeRandomAmountSubMenu.show();
        changeRandomAmountSubMenu.focus();
        safeRender();
        return;
      }

      promptBox.setFront();
      promptBox.input(
        `Masukkan rentang random amount untuk ${token2} pada pasangan ${pair} (format: min,max, contoh: 0.1,0.5)`,
        "",
        (err, valueToken2) => {
          promptBox.hide();
          safeRender();
          if (err || !valueToken2) {
            addLog(
              `Change Random Amount: Input untuk ${token2} pada ${pair} dibatalkan.`,
              "system"
            );
            changeRandomAmountSubMenu.show();
            changeRandomAmountSubMenu.focus();
            safeRender();
            return;
          }
          const [minToken2, maxToken2] = valueToken2
            .split(",")
            .map((v) => parseFloat(v.trim()));
          if (
            isNaN(minToken2) ||
            isNaN(maxToken2) ||
            minToken2 <= 0 ||
            maxToken2 <= minToken2
          ) {
            addLog(
              `Change Random Amount: Input tidak valid untuk ${token2} pada ${pair}. Gunakan format min,max (contoh: 0.1,0.5) dengan min > 0 dan max > min.`,
              "error"
            );
            changeRandomAmountSubMenu.show();
            changeRandomAmountSubMenu.focus();
            safeRender();
            return;
          }

          randomAmountRanges[pairKey] = {
            MON: { min: minMon, max: maxMon },
            [token2]: { min: minToken2, max: maxToken2 },
          };
          addLog(
            `Change Random Amount: Random Ammount ${pair} diubah menjadi MON: ${minMon} - ${maxMon}, ${token2}: ${minToken2} - ${maxToken2}.`,
            "success"
          );
          changeRandomAmountSubMenu.show();
          changeRandomAmountSubMenu.focus();
          safeRender();
        }
      );
    }
  );
}

mainMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Clober Swap") {
    cloberSwapSubMenu.show();
    cloberSwapSubMenu.focus();
    safeRender();
  } else if (selected === "Antrian Transaksi") {
    showTransactionQueueMenu();
  } else if (selected === "Stop Transaction") {
    if (swapRunning) {
      swapCancelled = true;
      addLog("Stop Transaction: Transaksi swap akan dihentikan.", "system");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Refresh") {
    updateWalletData();
    safeRender();
    addLog("Refreshed", "system");
  } else if (selected === "Exit") {
    process.exit(0);
  }
});

cloberSwapSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "Auto Swap MON & WMON") {
    if (swapRunning) {
      addLog(
        "Transaksi Clober Swap sedang berjalan. Hentikan transaksi terlebih dahulu.",
        "warning"
      );
    } else {
      runAutoSwapMonWmon();
    }
  } else if (selected === "Auto Swap MON & USDC") {
    if (swapRunning) {
      addLog(
        "Transaksi Clober Swap sedang berjalan. Hentikan transaksi terlebih dahulu.",
        "warning"
      );
    } else {
      runAutoSwapMonUsdc();
    }
  } else if (selected === "Auto Swap MON & sMON") {
    if (swapRunning) {
      addLog(
        "Transaksi Clober Swap sedang berjalan. Hentikan transaksi terlebih dahulu.",
        "warning"
      );
    } else {
      runAutoSwapMonSmon();
    }
  } else if (selected === "Auto Swap MON & DAK") {
    if (swapRunning) {
      addLog(
        "Transaksi Clober Swap sedang berjalan. Hentikan transaksi terlebih dahulu.",
        "warning"
      );
    } else {
      runAutoSwapMonDak();
    }
  } else if (selected === "Change Random Amount") {
    cloberSwapSubMenu.hide();
    changeRandomAmountSubMenu.show();
    changeRandomAmountSubMenu.focus();
    safeRender();
  } else if (selected === "Stop Transaction") {
    if (swapRunning) {
      swapCancelled = true;
      addLog("Clober Swap: Perintah Stop Transaction diterima.", "swap");
    } else {
      addLog("Clober Swap: Tidak ada transaksi yang berjalan.", "swap");
    }
  } else if (selected === "Clear Transaction Logs") {
    clearTransactionLogs();
  } else if (selected === "Back To Main Menu") {
    cloberSwapSubMenu.hide();
    mainMenu.show();
    mainMenu.focus();
    safeRender();
  } else if (selected === "Refresh") {
    updateWalletData();
    safeRender();
    addLog("Refreshed", "system");
  }
});

changeRandomAmountSubMenu.on("select", (item) => {
  const selected = item.getText();
  if (selected === "MON & WMON") {
    changeRandomAmount("MON & WMON");
  } else if (selected === "MON & USDC") {
    changeRandomAmount("MON & USDC");
  } else if (selected === "MON & sMON") {
    changeRandomAmount("MON & sMON");
  } else if (selected === "MON & DAK") {
    changeRandomAmount("MON & DAK");
  } else if (selected === "Back To Clober Swap Menu") {
    changeRandomAmountSubMenu.hide();
    cloberSwapSubMenu.show();
    cloberSwapSubMenu.focus();
    safeRender();
  }
});

screen.key(["escape", "q", "C-c"], () => process.exit(0));
screen.key(["C-up"], () => {
  logsBox.scroll(-1);
  safeRender();
});
screen.key(["C-down"], () => {
  logsBox.scroll(1);
  safeRender();
});

safeRender();
mainMenu.focus();
addLog("Dont Forget To Subscribe YT And Telegram @NTExhaust!!", "system");
updateWalletData();
