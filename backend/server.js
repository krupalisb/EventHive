require("dotenv").config();

const SibApiV3Sdk = require("sib-api-v3-sdk");

const client = SibApiV3Sdk.ApiClient.instance;

client.authentications["api-key"].apiKey =
process.env.BREVO_API_KEY;

const emailApi =
new SibApiV3Sdk.TransactionalEmailsApi();

const express = require("express");
const cors = require("cors");
const PDFDocument = require("pdfkit");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

// ================= SUPABASE =================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ================= EMAIL =================
const transporter = nodemailer.createTransport({
host:"smtp-relay.brevo.com",
port:587,
secure:false,
auth:{
user:process.env.EMAIL_USER,
pass:process.env.EMAIL_PASS
}
});

transporter.verify(function(error, success){
if(error){
console.log("Mail Error:", error);
}else{
console.log("Mail Server Ready ✅");
}
});

// ================= HELPERS =================
async function isEmailEnabled() {
  const { data } = await supabase.from("settings").select("*").limit(1);
  return data?.[0]?.email_enabled;
}

async function getAllPeople() {
  const { data: users } = await supabase.from("users").select("email, name");
  const { data: visitors } = await supabase.from("visitors").select("email, name");

  const all = [...(users || []), ...(visitors || [])];
  const map = {};

  all.forEach(p => {
    if (p.email && !map[p.email]) map[p.email] = p;
  });

  return Object.values(map);
}

// ================= TEST =================
app.get("/", (req, res) => res.send("Backend running 🚀"));

// ================= DASHBOARD =================
app.get("/dashboard", async (req, res) => {
try{
const { data: users } =
await supabase
.from("users")
.select("*");

const { data: events } =
await supabase
.from("events")
.select("*");

const now = new Date();

/* count ended events */
let completed =
events.filter(e=>{

let end=
new Date(
`${e.event_date}T${e.end_time}`
);

return now > end;

}).length;

res.json({
totalEvents:
events?.length || 0,

totalRegistrations:
users?.length || 0,

approved:
users?.filter(
u=>u.attendance
).length || 0,

completed: completed,

recent:
users?.slice(-5).reverse() || []
});

}
catch{

res.json({
totalEvents:0,
totalRegistrations:0,
approved:0,
completed:0,
recent:[]
});

}
});

// ================= ANALYTICS =================
app.get("/analytics", async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("event, attendance");

  const registered = {};
  const entered = {};

  data.forEach(u => {
    // registered count
    registered[u.event] = (registered[u.event] || 0) + 1;

    // entered count
    if (u.attendance) {
      entered[u.event] = (entered[u.event] || 0) + 1;
    }
  });

  res.json({
    registeredLabels: Object.keys(registered),
    registeredValues: Object.values(registered),
    enteredLabels: Object.keys(entered),
    enteredValues: Object.values(entered)
  });
});

app.post("/register", async (req,res)=>{
try{

const {
name,
email,
event,
teamName,
members
}=req.body;


for(let member of members){

const qrData=
`${event}-${member.email}-${Date.now()}`;

const qrCode=
await QRCode.toDataURL(
qrData
);


// save every member as participant
await supabase
.from("users")
.insert([
{
name:member.name,
email:member.email,
event:event,
team_name:teamName,
team_leader:
member.email===email,
qr_code:qrCode,
qr_text:qrData,
attendance:false
}
]);


// send each member their own QR
if(await isEmailEnabled()){

const qrBuffer=
Buffer.from(
qrCode.split(
"base64,"
)[1],
"base64"
);

await transporter.sendMail({

to:member.email,

subject:
"Event Registration Successful 🎉",

html:`
<h2>EventHive Registration</h2>

<p>Hello ${member.name},</p>

<p>
You are registered for
<b>${event}</b>
as part of team
<b>${teamName}</b>.
</p>

<p>Your entry QR is attached.</p>
`,

attachments:[
{
filename:"qr.png",
content:qrBuffer
}
]

});

}

}


res.json({
message:
"Team Registered & QR sent to all members ✅"
});

}
catch(err){

console.log(err);

res.json({
message:"Registration Error ❌"
});

}
});

// ================= VISITOR =================
app.post("/visitor-register", async (req, res) => {
  try {

    const { name, email } = req.body;

    // check if visitor already exists
    const { data: existing } = await supabase
      .from("visitors")
      .select("*")
      .eq("email", email);

    let qrData;
    let qrCode;

    if (existing && existing.length > 0) {

      // reuse old QR (do not generate new ones)
      qrData = existing[0].qr_text;
      qrCode = existing[0].qr_code;

    } else {

      // generate only once
      qrData = `VISITOR-${name}-${email}`;
      qrCode = await QRCode.toDataURL(qrData);

      await supabase.from("visitors").insert([
        {
          name,
          email,
          qr_code: qrCode,
          qr_text: qrData,
          attendance: false
        }
      ]);
    }


    if (await isEmailEnabled()) {

      const qrBuffer = Buffer.from(
        qrCode.split("base64,")[1],
        "base64"
      );

      await transporter.sendMail({
        to: email,
        subject: "Entry Pass 🎟️",
        html: `
          <h2>Visitor Entry Pass</h2>
          <p>Hello ${name},</p>
          <p>Use this same QR for event entry.</p>
        `,
        attachments: [
          {
            filename: "visitor-qr.png",
            content: qrBuffer
          }
        ]
      });
    }

    res.json({
      message: "Visitor registered 🎉"
    });

  } catch (err) {
    console.log(err);
    res.json({
      message: "Error"
    });
  }
});

// ================= SCAN =================
app.post("/scan", async (req,res)=>{
try{

const { qrData } = req.body;


// check participants
const { data: users } = await supabase
.from("users")
.select("*")
.eq("qr_text", qrData);


if(users && users.length>0){

const user=users[0];

if(user.attendance){
return res.json({
message:"Already Entered ⚠️",
name:user.name,
event:user.event
});
}

await supabase
.from("users")
.update({attendance:true})
.eq("id",user.id);

return res.json({
message:"Entry Allowed ✅",
name:user.name,
event:user.event
});
}


// check visitors
const { data: visitors } = await supabase
.from("visitors")
.select("*")
.eq("qr_text", qrData);

if(visitors && visitors.length>0){

const visitor=visitors[0];

if(visitor.entry){
return res.json({
message:"Already Entered ⚠️",
name:visitor.name,
event:"Visitor"
});
}

await supabase
.from("visitors")
.update({entry:true})
.eq("id",visitor.id);

return res.json({
message:"Visitor Verified ✅",
name:visitor.name,
event:"Visitor"
});
}

return res.json({
message:"Invalid QR ❌"
});

}catch(err){
console.log(err);
res.json({
message:"Error scanning QR"
});
}
});

// ================= USERS =================
app.get("/users", async (req, res) => {
  const { data } = await supabase.from("users").select("*");
  res.json(data);
});

app.post("/attendance", async (req, res) => {
  const { id, status } = req.body;

  await supabase.from("users").update({ attendance: status }).eq("id", id);
  res.json({ message: "Updated" });
});

app.delete("/delete-event/:id", async(req,res)=>{
try{

const id=req.params.id;

// get event name first
const {data:eventObj}=await supabase
.from("events")
.select("name")
.eq("id",id)
.single();

const eventName=eventObj.name;


// delete related registrations
await supabase
.from("users")
.delete()
.eq("event",eventName);


// delete related scores
await supabase
.from("scores")
.delete()
.eq("event",eventName);


// delete event
await supabase
.from("events")
.delete()
.eq("id",id);


res.json({
message:"Event deleted ✅"
});

}catch(err){
console.log(err);
res.json({
message:"Delete failed ❌"
});
}
});

// ================= EVENTS =================
app.post("/add-event", async (req,res)=>{

const {
name,
event_date,
start_time,
end_time
}=req.body;

await supabase
.from("events")
.insert([
{
name,
event_date,
start_time,
end_time
}
]);

res.json({
message:"Event added ✅"
});

});

app.get("/events", async (req, res) => {
  const { data } = await supabase.from("events").select("*");
  res.json(data);
});

// ================= SCORING =================
app.post("/add-score", async(req,res)=>{

try{

const {
user_id,
event,
judge1,
judge2
}=req.body;


/* Judge1 update or insert */
await supabase
.from("scores")
.upsert(
[
{
user_id:user_id,
event:event,
judge:"Judge1",
marks:Number(judge1)
}
],
{
onConflict:"user_id,event,judge"
}
);


/* Judge2 update or insert */
await supabase
.from("scores")
.upsert(
[
{
user_id:user_id,
event:event,
judge:"Judge2",
marks:Number(judge2)
}
],
{
onConflict:"user_id,event,judge"
}
);


res.json({
message:"Scores Updated Successfully ✅"
});

}
catch(err){

console.log(err);

res.json({
message:"Error Saving Scores ❌"
});

}

});

// ================= RESULTS =================
app.get("/results", async(req,res)=>{
try{

const {data:users}=await supabase
.from("users")
.select("*");


const {data:scores}=await supabase
.from("scores")
.select("*");


const teams={};


// group by team
users.forEach(u=>{

let team=
u.team_name || u.name;

if(!teams[team]){
teams[team]={
team:team,
event:u.event,
members:[],
score:0
};
}

teams[team].members.push(u.name);

});


// add scores
scores.forEach(s=>{

if(teams[s.user_id]){
teams[s.user_id].score += s.marks;
}

});


// group by event
const grouped={};

Object.values(teams).forEach(t=>{

if(!grouped[t.event]){
grouped[t.event]=[];
}

grouped[t.event].push(t);

});


const results=[];

for(let event in grouped){

let list=
grouped[event].sort(
(a,b)=>b.score-a.score
);

results.push({
event,
winner:list[0]||null,
runner:list[1]||null,
leaderboard:list
});

}

res.json(results);

}
catch(err){
console.log(err);
res.json([]);
}
});


// ================= ANNOUNCEMENTS =================
app.post("/announce", async (req, res) => {
  if (!(await isEmailEnabled())) return res.json({ message: "Emails OFF" });

  const {title,message,event}=req.body;

  await supabase.from("announcements").insert([{ title, message }]);

  let people;

  if(event && event!=="all"){

  const {data}=await supabase
  .from("users")
  .select("name,email")
  .eq("event",event);

  people=data;

  }else{

  people=await getAllPeople();

  }

  for (let p of people) {
    await transporter.sendMail({
      to: p.email,
      subject: title,
      html: message
    });
  }

  res.json({ message: "Sent" });
});

app.get("/announcements", async (req, res) => {
  const { data } = await supabase.from("announcements").select("*");
  res.json(data);
});

// ================= SETTINGS =================
// GET settings
app.get("/settings", async (req, res) => {
  const { data } = await supabase
    .from("settings")
    .select("*")
    .eq("id", 1)
    .single();

  res.json(data);
});


// SAVE settings
app.post("/settings", async (req, res) => {
  const { adminName, defaultEvent } = req.body;

  await supabase.from("settings").upsert([
    { id: 1, adminName, defaultEvent }
  ]);

  res.json({ message: "Settings saved ✅" });
});

app.delete("/delete-event/:id", async (req, res) => {
  await supabase.from("events").delete().eq("id", req.params.id);
  res.json({ message: "Deleted" });
});

app.get("/notifications", async (req, res) => {
  const { data } = await supabase
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(5);

  res.json(data);
});

app.get("/live-entries", async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("name, event")
    .eq("attendance", true)
    .order("id", { ascending: false })
    .limit(5);

  res.json(data);
});

app.get("/entry-count", async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("event, attendance");

  const counts = {};

  data.forEach(u => {
    if (u.attendance) {
      counts[u.event] = (counts[u.event] || 0) + 1;
    }
  });

  res.json(counts);
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;

  // simple login (for project)
  if (username === "admin" && password === "1234") {
    return res.json({
      success: true,
      role: "admin"
    });
  }

  res.json({
    success: false,
    message: "Invalid credentials"
  });
});

app.get("/entries", async (req, res) => {
  const { data } = await supabase
    .from("users")
    .select("*")
    .eq("attendance", true);

  res.json(data);
});

// ================= REMINDERS =================
app.post("/send-reminders", async (req,res)=>{
try{

if(!(await isEmailEnabled())){
return res.json({
message:"Emails are disabled ❌"
});
}

const people=await getAllPeople();

await Promise.allSettled(

people.map(p=>
emailApi.sendTransacEmail({
sender:{
email:"nibblesandnature@gmail.com"
},
to:[
{
email:p.email
}
],
subject:"Event Reminder 📢",
htmlContent:`
<p>Hello ${p.name},</p>
<p>Don't forget your event!</p>
`
})
)

);

res.json({
message:"Reminders sent ✅"
});

}
catch(err){

console.log(err);

res.json({
message:"Error sending reminders ❌"
});

}
});

// ================= CERTIFICATES =================
app.post("/send-certificates", async (req, res) => {
try{

const path=require("path");
const PDFDocument=require("pdfkit");

const {data:users}=await supabase
.from("users")
.select("id,name,email,event,team_name");

const {data:scores}=await supabase
.from("scores")
.select("user_id,marks");


const scoreMap={};

scores.forEach(s=>{
if(!scoreMap[s.user_id]){
scoreMap[s.user_id]=0;
}
scoreMap[s.user_id]+=s.marks;
});


const grouped={};

users.forEach(u=>{

if(!grouped[u.event]){
grouped[u.event]=[];
}

const team=u.team_name || u.name;

let existing=
grouped[u.event].find(
t=>t.team===team
);

if(!existing){

existing={
team:team,
members:[],
score:scoreMap[team] || 0
};

grouped[u.event].push(existing);

}

existing.members.push({
name:u.name,
email:u.email
});

});



for(let event in grouped){

let list=
grouped[event].sort(
(a,b)=>b.score-a.score
);


for(let i=0;i<list.length;i++){

let roles=["Participant"];

if(i===0){
roles.push("1st place");
}

else if(i===1){
roles.push("2nd place");
}


for(const member of list[i].members){

for(const role of roles){

const doc=
new PDFDocument({
size:"A4",
layout:"landscape",
margin:0
});

const buffers=[];

doc.on(
"data",
buffers.push.bind(buffers)
);


let bgPath="";

if(role==="1st place"){
bgPath=
path.join(
__dirname,
"bg-winner.png"
);
}
else if(role==="2nd place"){
bgPath=
path.join(
__dirname,
"bg-runner.png"
);
}
else{
bgPath=
path.join(
__dirname,
"bg-participation.png"
);
}


doc.image(
bgPath,
0,
0,
{
fit:[842,595]
}
);


doc.registerFont(
"custom",
path.join(
__dirname,
"OpenSans-Regular.ttf"
)
);


doc.font("Times-Bold")
.fontSize(32)
.fillColor("#8B7500")
.text(
"CERTIFICATE OF ACHIEVEMENT",
0,
110,
{
width:842,
align:"center"
}
);


doc.font("custom")
.fontSize(20)
.fillColor("#222")
.text(
"This is proudly presented to",
0,
190,
{
width:842,
align:"center"
}
);


doc.font("Times-BoldItalic")
.fontSize(34)
.fillColor("#000")
.text(
member.name,
0,
255,
{
width:842,
align:"center"
}
);


doc.moveTo(280,305)
.lineTo(560,305)
.stroke();


doc.font("custom")
.fontSize(20)
.text(
role==="Participant"
? "For Participating In"
: `For securing ${role}`,
0,
355,
{
width:842,
align:"center"
}
);


doc.font("Times-Bold")
.fontSize(26)
.fillColor("#7A0019")
.text(
event,
0,
410,
{
width:842,
align:"center"
}
);


doc.font("custom")
.fontSize(15)
.text(
"EventHive Technical Fest 2026",
0,
455,
{
width:842,
align:"center"
}
);


doc.fontSize(13)
.text(
"Date: April 2026",
120,
520
);


doc.image(
path.join(
__dirname,
"seal.png"
),
125,
450,
{
width:85
}
);


doc.image(
path.join(
__dirname,
"sign.png"
),
600,
440,
{
width:100
}
);


doc.fontSize(12)
.text(
"Authorized Signature",
565,
525,
{
width:150,
align:"center"
}
);


/* FIXED PART */
await new Promise((resolve,reject)=>{

doc.on("end",async()=>{

try{

const pdfData=
Buffer.concat(buffers);

await transporter.sendMail({
to:member.email,
subject:`Certificate - ${event}`,
html:`<p>Hello ${member.name}, your certificate is attached.</p>`,
attachments:[
{
filename:"certificate.pdf",
content:pdfData
}
]
});

await supabase
.from("user_certificates")
.upsert(
[{
email:member.email,
event:event,
certificate_type:role
}],
{
onConflict:
"email,event,certificate_type"
}
);

resolve();

}
catch(err){
reject(err);
}

});

doc.end();

});
/* FIXED PART ENDS */


}

}

}

}


res.json({
message:
"Certificates sent successfully ✅"
});

}
catch(err){

console.log(err);

res.json({
message:
"Error ❌"
});

}
});


app.get("/visitor-dashboard", async (req,res)=>{
try{

const { data: visitors } = await supabase
.from("visitors")
.select("*");

res.json({
totalVisitors: visitors.length,
checkedIn: visitors.filter(v=>v.entry).length,
visitors
});

}catch(err){
console.log(err);
res.json({
totalVisitors:0,
checkedIn:0,
visitors:[]
});
}
});

app.get("/get-scores/:id", async(req,res)=>{

try{

const id=
req.params.id;

const {data,error}=await supabase
.from("scores")
.select("*")
.eq("user_id",id);


if(
!data ||
data.length===0
){
return res.json({
judge1:"",
judge2:""
});
}


res.json({

judge1:
data.find(
s=>s.judge==="Judge1"
)?.marks ?? "",

judge2:
data.find(
s=>s.judge==="Judge2"
)?.marks ?? ""

});

}
catch(err){

console.log(err);

res.json({
judge1:"",
judge2:""
});

}

});

app.get("/my-events/:email", async(req,res)=>{

const email=
req.params.email;

const {data}=await supabase
.from("users")
.select("*")
.eq("email",email);

res.json(data);

});

app.get("/event-status",async(req,res)=>{

const {data:events}=
await supabase
.from("events")
.select("*");

const now=new Date();

const updated=
events.map(e=>{

let start=
new Date(
`${e.event_date}T${e.start_time}`
);

let end=
new Date(
`${e.event_date}T${e.end_time}`
);

let status="Upcoming";

if(now>=start && now<=end){
status="Live";
}

if(now>end){
status="Ended";
}

return{
...e,
status
};

});

res.json(updated);

});

app.get("/certificates", async(req,res)=>{

const {data,error}=await supabase
.from("user_certificates")
.select("*");

res.json(data || []);

});

app.get(
"/download-certificate",
async(req,res)=>{

const PDFDocument=
require("pdfkit");

const path=
require("path");

const email=
req.query.email;

const event=
req.query.event;

const type=req.query.type || "Participation";

// find user
const {data:users}=
await supabase
.from("users")
.select("*")
.eq("email",email.trim())
.ilike("event",event.trim());

if(!users.length){
return res.send(
"Certificate not found"
);
}

const user=
users[0];

res.setHeader(
"Content-Type",
"application/pdf"
);

res.setHeader(
"Content-Disposition",
`attachment; filename=${user.name}-certificate.pdf`
);


const doc=
new PDFDocument({
size:"A4",
layout:"landscape",
margin:0
});


doc.pipe(res);

let bg="bg-participation.png";

if(type==="1st place"){
bg="bg-winner.png";
}
else if(type==="2nd place"){
bg="bg-runner.png";
}
else{
bg="bg-participation.png";
}

doc.image(
path.join(__dirname,bg),
0,
0,
{
fit:[842,595]
}
);


doc.fontSize(32)
.text(
"CERTIFICATE OF ACHIEVEMENT",
0,
110,
{
align:"center"
}
);


doc.fontSize(20)
.text(
"This is proudly presented to",
0,
190,
{
align:"center"
}
);


doc.fontSize(34)
.text(
user.name,
0,
255,
{
align:"center"
}
);


doc.fontSize(22)
.text(
(type==="Participant" || type==="Participation")
? "For Participating In"
: `For securing ${type}`,
0,
355,
{
align:"center"
}
);


doc.fontSize(24)
.text(
event,
0,
410,
{
align:"center"
}
);


doc.image(
path.join(
__dirname,
"sign.png"
),
600,
440,
{
width:100
}
);

doc.end();

});

app.get("/my-qr/:email", async (req, res) => {
  try {
    const email = req.params.email.trim().toLowerCase();

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .order("created_at", { ascending: false })

    if (error) return res.status(500).json(error);

    if (!data || data.length === 0){
      return res.json(null);
    }

    res.json(data);

  } catch(err){
    res.status(500).json({ error: err.message });
  }
});
app.get("/my-scores/:email", async(req,res)=>{

try{

const email=req.params.email;

/* get user's team */
const {data:userData,error:userErr}=await supabase
.from("users")
.select("team_name,event")
.eq("email",email)
.single();

if(userErr || !userData){
return res.json({
event:"No Scores",
judge1:0,
judge2:0,
total:0
});
}

/* fetch TEAM scores */
const {data,error}=await supabase
.from("scores")
.select("*")
.eq("user_id",userData.team_name) // alpha
.eq("event",userData.event);

if(!data || data.length===0){
return res.json({
event:userData.event,
judge1:0,
judge2:0,
total:0
});
}

const judge1=
data.find(
x=>x.judge==="Judge1"
)?.marks || 0;

const judge2=
data.find(
x=>x.judge==="Judge2"
)?.marks || 0;

res.json({
event:userData.event,
judge1,
judge2,
total:judge1+judge2
});

}

catch(err){
console.log(err);

res.json({
event:"No Scores",
judge1:0,
judge2:0,
total:0
});
}

});

app.post(
"/update-event",
async(req,res)=>{

const {
id,
event_date,
start_time,
end_time
}=req.body;

await supabase
.from("events")
.update({
event_date,
start_time,
end_time
})
.eq("id",id);

res.json({
message:"Updated ✅"
});

});

app.get("/my-certificates/:email", async (req,res)=>{
try{

const email=req.params.email;

const { data,error } = await supabase
.from("user_certificates")
.select("event,certificate_type")
.eq("email",email);

if(error) throw error;

if(!data || data.length===0){
return res.json([]);
}

const formatted=data.map(item=>({
event:item.event,
type:item.certificate_type
}));

res.json(formatted);

}
catch(err){
console.log(err);
res.json([]);
}
});

app.delete("/user/:id", async(req,res)=>{
try{

await supabase
.from("users")
.delete()
.eq("id",req.params.id);

res.json({
message:"User deleted ✅"
});

}
catch(err){

console.log(err);

res.json({
message:"Delete failed ❌"
});

}
});

app.delete("/announcement/:id", async(req,res)=>{
try{

await supabase
.from("announcements")
.delete()
.eq("id",req.params.id);

res.json({
message:"Announcement deleted ✅"
});

}
catch(err){

console.log(err);

res.json({
message:"Delete failed ❌"
});

}
});

app.get("/test-email", async(req,res)=>{
try{
await transporter.sendMail({
from: process.env.EMAIL_USER,
to: "nibblesandnature@gmail.com",
subject:"Brevo Test",
text:"Test email working"
});

res.send("Email sent");
}catch(err){
console.log(err);
res.send("Failed");
}
});


// ================= SERVER =================
app.listen(5000, () => console.log("Server running 🚀"));