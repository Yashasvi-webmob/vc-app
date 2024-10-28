
import dotenv from 'dotenv';
dotenv.config();

/**
 * integrating mediasoup server with a node.js application
 */

/* Please follow mediasoup installation requirements */
/* https://mediasoup.org/documentation/v3/mediasoup/installation/ */
import express from "express";
const app = express();
import { STUN_SERVERS } from "./constants/stunServers.js";
// import https from 'httpolyglot'
import https from "https";
import fs from "fs";
import path from "path";
const __dirname = path.resolve();

import { Server } from "socket.io";
import mediasoup, { getSupportedRtpCapabilities } from "mediasoup";

const iceServer = [
  {
    urls: STUN_SERVERS[0].urls,
  },
];

// // app.js
// const iceServers = {
//   iceServers: [
//     { urls: 'stun:stun.l.google.com:19302' },  // Example STUN server
//     // Add your TURN server if necessary, example:
//     // {
//     //   urls: 'turn:your-turn-server.com',
//     //   username: 'username',
//     //   credential: 'password'
//     // }
//   ]
// };

// const peerConnection = new RTCPeerConnection(iceServers);

// // Log ICE candidates
// peerConnection.onicecandidate = (event) => {
//   if (event.candidate) {
//     console.log('New ICE candidate:', event.candidate);
//     // Send the candidate to the remote peer via your signaling server
//   } else {
//     console.log('All ICE candidates have been sent.');
//   }
// };



app.get("/", (req, res) => {
  res.send("Hello from mediasoup app!");
});

app.use("/sfu", express.static(path.join(__dirname, "public")));

// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: fs.readFileSync("./server/ssl/cert.pem", "utf-8"),
};

const httpsServer = https.createServer(options, app);
httpsServer.listen(4004, () => {
  console.log("listening on port: " + 4004);
});

const io = new Server(httpsServer);

// socket.io namespace (could represent a room?)
const peers = io.of("/mediasoup");

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/
let worker;
let router;
let producerTransport;
let consumerTransport;
let producer;
let consumer;

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2020,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    // This implies something serious happened, so kill the application
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

// This is an Array of RtpCapabilities
// https://mediasoup.org/documentation/v3/mediasoup/rtp-parameters-and-capabilities/#RtpCodecCapability
// list of media codecs supported by mediasoup ...
// https://github.com/versatica/mediasoup/blob/v3/src/supportedRtpCapabilities.ts
const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

peers.on("connection", async (socket) => {
  console.log(socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
    existsProducer: producer ? true : false,
  });

  socket.on("disconnect", () => {
    // do some cleanup
    console.log("peer disconnected");
  });

  socket.on("createRoom", async (callback) => {
    if (router === undefined) {
      // worker.createRouter(options)
      // options = { mediaCodecs, appData }
      // mediaCodecs -> defined above
      // appData -> custom application data - we are not supplying any
      // none of the two are required
      router = await worker.createRouter({ mediaCodecs });
      console.log(`Router ID: ${router.id}`);
    }

    getRtpCapabilities(callback);
  });

  const getRtpCapabilities = (callback) => {
    const rtpCapabilities = router.rtpCapabilities;

    callback({ rtpCapabilities });
  };

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on("createWebRtcTransport", async ({ sender }, callback) => {
    console.log(`Is this a sender request? ${sender}`);
    // The client indicates if it is a producer or a consumer
    // if sender is true, indicates a producer else a consumer
    if (sender) producerTransport = await createWebRtcTransport(callback);
    else consumerTransport = await createWebRtcTransport(callback);
  });

  // see client's socket.emit('transport-connect', ...)
  socket.on("transport-connect", async ({ dtlsParameters }) => {
    console.log("DTLS PARAMS... ", { dtlsParameters });
    await producerTransport.connect({ dtlsParameters });
  });

  // see client's socket.emit('transport-produce', ...)
  socket.on(
    "transport-produce",
    async ({ kind, rtpParameters, appData }, callback) => {
      // call produce based on the prameters from the client
      producer = await producerTransport.produce({
        kind,
        rtpParameters,
      });

      console.log("Producer ID: ", producer.id, producer.kind);

      producer.on("transportclose", () => {
        console.log("transport for this producer closed ");
        producer.close();
      });

      // Send back to the client the Producer's id
      callback({
        id: producer.id,
      });
    }
  );

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on("transport-recv-connect", async ({ dtlsParameters }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    await consumerTransport.connect({ dtlsParameters });
  });

  socket.on("consume", async ({ rtpCapabilities }, callback) => {
    try {
      // check if the router can consume the specified producer
      if (
        router.canConsume({
          producerId: producer.id,
          rtpCapabilities,
        })
      ) {
        // transport can now consume and return a consumer
        consumer = await consumerTransport.consume({
          producerId: producer.id,
          rtpCapabilities,
          paused: true,
        });

        consumer.on("transportclose", () => {
          console.log("transport close from consumer");
        });

        consumer.on("producerclose", () => {
          console.log("producer of consumer closed");
        });

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: producer.id,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
        };

        // send the parameters to the client
        callback({ params });
      }
    } catch (error) {
      console.log(error.message);
      callback({
        params: {
          error: error,
        },
      });
    }
  });

  socket.on("consumer-resume", async () => {
    console.log("consumer resume");
    const resumeVal = await consumer.resume();
    console.log({ resumeVal });
    const stats = await consumer.getStats();
    console.log("Consumer stats:", stats);

    // Look for specific packet-related stats
    stats.forEach((stat) => {
      if (stat.type === "inbound-rtp") {
        console.log(
          `Packets received: ${stat.packetsReceived}, Packets lost: ${stat.packetsLost}`
        );
      }
    });
  });
});

const createWebRtcTransport = async (callback) => {
  try {
    // Get the external IP of your server
    const localIp = '0.0.0.0';  // Bind to all IPv4 interfaces
    const externalIp = process.env.EXTERNAL_IP || '192.168.1.X'; // Replace X with your server's local IP

    const webRtcTransport_options = {
      listenIps: [
        {
          ip: localIp,
          announcedIp: externalIp, // IP that will be advertised in ICE candidates
        }
      ],
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
      minimumAvailableOutgoingBitrate: 600000,
      maxSctpMessageSize: 262144,
      // Enable TURN if needed
      enableSctp: true,
      numSctpStreams: { OS: 1024, MIS: 1024 },
    };

    let transport = await router.createWebRtcTransport(webRtcTransport_options);
    console.log(`transport id: ${transport.id}`);

    transport.on('dtlsstatechange', (dtlsState) => {
      if (dtlsState === 'closed') {
        transport.close();
      }
    });

    transport.on('close', () => {
      console.log('transport closed');
    });

    // Log ICE connection state changes
    transport.on('icestatechange', (iceState) => {
      console.log('ICE state changed to', iceState);
    });

    callback({
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      },
    });

    return transport;
  } catch (error) {
    console.log(error);
    callback({
      params: {
        error: error,
      },
    });
  }
};

// const createWebRtcTransport = async (callback) => {
//   try {
//     // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
//     const webRtcTransport_options = {
//       listenIps: [
//         {
//           ip: "0.0.0.0", // replace with relevant IP address
//           announcedIp: "127.0.0.1",
//         },
//       ],
//       enableUdp: true,
//       enableTcp: true,
//       preferUdp: true,
//       iceServer,
//     };

//     // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
//     let transport = await router.createWebRtcTransport(webRtcTransport_options);
//     console.log(`transport id: ${transport.id}`);

//     transport.on("dtlsstatechange", (dtlsState) => {
//       if (dtlsState === "closed") {
//         transport.close();
//       }
//     });

//     transport.on("close", () => {
//       console.log("transport closed");
//     });

//     // send back to the client the following prameters
//     callback({
//       // https://mediasoup.org/documentation/v3/mediasoup-client/api/#TransportOptions
//       params: {
//         id: transport.id,
//         iceParameters: transport.iceParameters,
//         iceCandidates: transport.iceCandidates,
//         dtlsParameters: transport.dtlsParameters,
//       },
//     });

//     return transport;
//   } catch (error) {
//     console.log(error);
//     callback({
//       params: {
//         error: error,
//       },
//     });
//   }
// };
