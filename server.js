import express from "express";

app.get("/", (req, res) => {
  res.send("Voice assistant is running 🚀");
});

const app = express();
app.use(express.urlencoded({ extended: false }));

app.post("/voice", (req, res) => {
  const twiml = `
    <Response>
      <Say voice="Polly.Joanna">
        Hello. This is the HVAC assistant. We are currently setting up our AI system.
      </Say>
    </Response>
  `;
  res.type("text/xml");
  res.send(twiml);
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port " + port);
});
