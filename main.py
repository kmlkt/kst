import asyncio
from contextlib import asynccontextmanager
import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile
from tortoise.contrib.fastapi import register_tortoise
#from ai import inspect_pump
from dtos import Device_Dto, Analysis_Dto
from emulator import spawn_errors
from logic import check_parameter
from models import Device, Parameter

load_dotenv()

app = FastAPI(title="KST")

@app.get("/devices/{tag}", response_model=Device_Dto)
async def get_device(tag: str):
    device = await Device.get_or_none(tag=tag)
    if not device:
        raise HTTPException(status_code=404, detail="Устройство не найдено")
    await device.fetch_related("parameters")
    return Device_Dto(tag=device.tag, name=device.name, parameters=sorted([check_parameter(device, p) for p in device.parameters], key=lambda x:x.parameter))

# @app.post("/ai")
# async def ai(image: UploadFile) -> Analysis_Dto:
#     d = await inspect_pump(image)
#     return Analysis_Dto(
#         device_points=d["polygon"],
#         warnings=[
#             []
#         ]
#     )


async def spawn():
    await asyncio.sleep(1)
    while True:
        await spawn_errors()

register_tortoise(
    app,
    db_url=os.getenv("DB_URL"),
    modules={"models": ["models"]},
    generate_schemas=True,
    add_exception_handlers=True,
)

asyncio.create_task(spawn())